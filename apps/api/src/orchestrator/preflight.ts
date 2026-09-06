/**
 * Refusing a job that cannot possibly run, before anybody waits for it.
 *
 * Checking that a backend has the *checkpoint* is not enough. A template can
 * name several files, and the ones that are not the checkpoint are exactly the
 * ones nobody notices are missing. The LTX-Video templates are the live
 * example: they need a T5 text encoder this box does not have, and the LTX
 * weights are filed where `CheckpointLoaderSimple` cannot see them, so the job
 * is accepted, queued, dispatched, and only then refused — verbatim, from the
 * running server:
 *
 *   CheckpointLoaderSimple 4: Value not in list: ckpt_name:
 *     'ltx-video-2b-v0.9.1.safetensors' not in
 *     ['SDXL\sd_xl_base_1.0.safetensors', 'hunyuan_video_720p_fp8_e4m3fn.safetensors']
 *   CLIPLoader 12: Value not in list: clip_name: 't5xxl_fp16.safetensors' not in []
 *
 * The user waits for that, and then gets a failure they can do nothing with.
 * `/object_info` already knows the answer — every loader reports its installed
 * files as the option list of its input — so we ask it first and say no
 * immediately, naming the file and, where we can, what it is for.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONLY LOOKS AT FILE-VALUED LITERALS, and never at every combo.
 *
 * `LoadImage.image` is a combo too. Observed on the same server:
 *
 *   GET /object_info/LoadImage
 *     -> {"required":{"image":[["example.png","probe.png"],{"image_upload":true}]}}
 *
 * An img2img graph names `comfy-studio/<hash>.png`, which is *not* in that list
 * and never will be: the file is uploaded to the backend at dispatch, into a
 * subfolder, and ComfyUI's own validator does not use the combo list for this
 * input — `LoadImage` declares `VALIDATE_INPUTS` and calls
 * `exists_annotated_filepath()` instead (see workflows/init-image.ts, which
 * verified all of this against the same box). Rejecting on combo membership
 * would therefore break every img2img job.
 *
 * So the rule is: a value is checked only when it *looks like a model file* —
 * one of the weight extensions ComfyUI loads. An image name, a sampler name, a
 * scheduler, a filename prefix and a prompt are all left alone. Classes that
 * validate their own paths are skipped outright as well, belt and braces.
 * ---------------------------------------------------------------------------
 */

import { ComfyClient, comboOptions, MODEL_EXTENSIONS, type ObjectInfo } from '../lib/comfy.js';
import type { ComfyApiGraph } from '../workflows/types.js';

/**
 * `/object_info` is a megabyte or so of JSON describing every node class on the
 * server, and it changes only when somebody installs a model. Fetching it per
 * job creation would make the Create screen slower than the generation. A short
 * TTL keeps "I just installed it" honest without hammering the backend.
 */
const TTL_MS = 60_000;

interface CacheEntry {
  at: number;
  /** The promise, not the value: concurrent job creations share one fetch. */
  info: Promise<ObjectInfo>;
}

const cache = new Map<string, CacheEntry>();

export async function objectInfoFor(baseUrl: string): Promise<ObjectInfo> {
  const hit = cache.get(baseUrl);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

  // 20s rather than the client's 8s default: this payload is large and a busy
  // backend serialises it while it is generating.
  const info = new ComfyClient(baseUrl, 20_000).objectInfo();
  cache.set(baseUrl, { at: Date.now(), info });
  // A failed fetch must not be cached, or one blip refuses jobs for a minute.
  info.catch(() => {
    if (cache.get(baseUrl)?.info === info) cache.delete(baseUrl);
  });
  return info;
}

/** Test seam, and a way for the models screen to force a re-read after an install. */
export function clearObjectInfoCache(baseUrl?: string): void {
  if (baseUrl) cache.delete(baseUrl);
  else cache.clear();
}

export interface MissingFile {
  nodeId: string;
  nodeClass: string;
  input: string;
  filename: string;
  /** What the backend does offer for this input, for the message. */
  available: string[];
}

export interface PreflightResult {
  missingFiles: MissingFile[];
  /** Node classes the graph uses that this backend has never heard of. */
  missingNodeClasses: string[];
}

/**
 * Classes whose file-shaped inputs are resolved by the node itself rather than
 * by combo membership. See the header: these declare `VALIDATE_INPUTS`.
 */
const SELF_VALIDATING = new Set(['LoadImage', 'LoadImageMask', 'LoadImageOutput', 'LoadVideo']);

/** What a missing file is *for*, so the message can suggest something. */
function purposeOf(nodeClass: string, filename: string): string | null {
  if (/^(CLIPLoader|DualCLIPLoader|TripleCLIPLoader)$/.test(nodeClass)) {
    // Naming the family is what makes this searchable: "T5 text encoder" is a
    // thing a user can go and find, "clip_name" is not.
    return /t5/i.test(filename) ? 'T5 text encoder' : 'text encoder';
  }
  if (/^(VAELoader)$/.test(nodeClass)) return 'VAE';
  if (/Lora/i.test(nodeClass)) return 'LoRA';
  if (/ControlNet/i.test(nodeClass)) return 'ControlNet';
  if (/Upscale/i.test(nodeClass)) return 'upscaling model';
  if (/^(CheckpointLoaderSimple|CheckpointLoader|UNETLoader)$/.test(nodeClass)) {
    return 'model checkpoint';
  }
  return null;
}

/**
 * Compare the way ComfyUI's own resolver effectively does: the fleet reports
 * Windows paths (`SDXL\sd_xl_base_1.0.safetensors`) and our database stores
 * whatever was reported, so a separator or a case difference is a false
 * rejection — the worst outcome here, since it refuses a job that would run.
 */
function sameFile(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Check a compiled graph against one backend's `/object_info`. Pure; the caller
 * decides what to do with the findings.
 */
export function checkGraph(graph: ComfyApiGraph, info: ObjectInfo): PreflightResult {
  const missingFiles: MissingFile[] = [];
  const missingNodeClasses: string[] = [];

  for (const [nodeId, node] of Object.entries(graph)) {
    const spec = info[node.class_type];
    if (!spec) {
      // A class the backend does not have at all — a custom node nobody
      // installed. Worth its own message: no file will fix it.
      if (!missingNodeClasses.includes(node.class_type)) missingNodeClasses.push(node.class_type);
      continue;
    }
    if (SELF_VALIDATING.has(node.class_type)) continue;

    for (const [input, value] of Object.entries(node.inputs)) {
      // A link (`["4", 0]`) is not a literal, and a number is not a file.
      if (typeof value !== 'string') continue;
      if (!MODEL_EXTENSIONS.test(value)) continue;

      const declared = spec.input?.required?.[input] ?? spec.input?.optional?.[input];
      const options = comboOptions(declared);
      // `null` means this input is not a combo (a STRING, say), so the server
      // never checks it against a list and neither should we. An empty array is
      // a combo with nothing installed — which is the CLIPLoader case above,
      // and is precisely what we want to catch.
      if (options === null) continue;
      if (options.some((option) => sameFile(option, value))) continue;

      missingFiles.push({
        nodeId,
        nodeClass: node.class_type,
        input,
        filename: value,
        available: options,
      });
    }
  }

  return { missingFiles, missingNodeClasses };
}

/**
 * Where else on this backend the same file *is* offered.
 *
 * This is the LTX-Video case and it is worth the extra scan: the weights are on
 * the disk, they are simply filed where `UNETLoader` sees them and
 * `CheckpointLoaderSimple` does not. "You do not have this file" would be false
 * and would send the user off to download it again; "it is there, but the
 * wrong loader can see it" is something an operator can fix by moving one file.
 */
function offeredElsewhere(info: ObjectInfo, filename: string, exceptClass: string): string[] {
  const classes: string[] = [];
  for (const [nodeClass, spec] of Object.entries(info)) {
    if (nodeClass === exceptClass) continue;
    const inputs = { ...(spec.input?.required ?? {}), ...(spec.input?.optional ?? {}) };
    for (const declared of Object.values(inputs)) {
      const options = comboOptions(declared);
      if (options?.some((option) => sameFile(option, filename))) {
        classes.push(nodeClass);
        break;
      }
    }
  }
  return classes;
}

/** `a T5 text encoder, "t5xxl_fp16.safetensors"` — what is actually missing. */
function describe(missing: MissingFile): string {
  const purpose = purposeOf(missing.nodeClass, missing.filename);
  return purpose ? `a ${purpose}, "${missing.filename}"` : `the file "${missing.filename}"`;
}

/** A sentence a person can act on, or null when the graph is fine. */
export function explain(
  result: PreflightResult,
  backendName: string,
  /** Optional: with it, a file that is present under the wrong loader is named as such. */
  info?: ObjectInfo,
): string | null {
  const [missing, ...rest] = result.missingFiles;
  if (missing) {
    const elsewhere = info ? offeredElsewhere(info, missing.filename, missing.nodeClass) : [];

    // Naming what *is* there turns "it failed" into "you picked the wrong one";
    // with nothing installed at all, saying so is the actionable part.
    const detail =
      elsewhere[0]
        ? ` The file is on that machine, but in a folder ${missing.nodeClass} does not read — ${elsewhere[0]} can see it, so it needs moving to the one ${missing.nodeClass} loads from.`
        : missing.available.length === 0
          ? ` Nothing at all is installed for ${missing.nodeClass}'s ${missing.input} there.`
          : ` It has: ${missing.available.slice(0, 6).join(', ')}${
              missing.available.length > 6 ? ', …' : ''
            }.`;

    const more = rest.length > 1 ? `, and ${rest.length - 1} more file${rest.length > 2 ? 's' : ''}` : '';
    const also = rest[0] ? ` It also needs ${describe(rest[0])}${more}.` : '';

    return `This workflow needs ${describe(missing)}, which ${backendName} cannot load.${detail}${also}`;
  }

  const [nodeClass] = result.missingNodeClasses;
  if (nodeClass) {
    return `${backendName} does not have the "${nodeClass}" node this workflow needs; it is a custom node that has to be installed there.`;
  }

  return null;
}

/**
 * The whole check for one backend. Returns a message to refuse with, or null.
 *
 * **Fails open.** If `/object_info` cannot be read we allow the job: this
 * exists to convert a slow, opaque failure into a fast, clear one, and turning
 * a flaky poll into "you may not generate" would be a worse bug than the one
 * being fixed.
 */
export async function preflight(
  graph: ComfyApiGraph,
  backend: { name: string; base_url: string },
): Promise<string | null> {
  let info: ObjectInfo;
  try {
    info = await objectInfoFor(backend.base_url);
  } catch {
    return null;
  }
  return explain(checkGraph(graph, info), backend.name, info);
}
