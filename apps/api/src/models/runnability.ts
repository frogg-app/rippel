/**
 * "Will this actually run?" — answered before the download, not after it.
 *
 * The catalogue offers 372 files. This studio can generate with perhaps a third
 * of them, and nothing on a card said which third: an operator picked a name,
 * waited out seven gigabytes, and then found out. The information needed to
 * answer was already in the process, in three separate places:
 *
 *   1. `workflows/registry.ts` — `capabilityOffersFor(family)` knows whether we
 *      have a graph for that family at all, and whether it is hand-authored or
 *      the generic Stable-Diffusion fallback.
 *   2. `orchestrator/preflight.ts` — `checkGraph` knows how to ask a backend's
 *      `/object_info` whether every file a graph names is loadable there. Its
 *      cache is reused rather than duplicated.
 *   3. The catalogue entry itself — `base` states the family, and `save_path`
 *      states which ComfyUI folder the file will land in.
 *
 * (3) is the one that is easy to miss and is the LTX-Video case the user keeps
 * hitting. `diffusion_models/…` and `checkpoints/…` are different folders, and
 * ComfyUI's loaders read one each: a file installed into `diffusion_models` is
 * invisible to `CheckpointLoaderSimple` forever, no matter how correct it is.
 * Our LTX templates load with `CheckpointLoaderSimple`, so a Wan or FLUX
 * diffusion_model entry is *statically* unrunnable and can be marked so without
 * asking any backend anything.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CAN AND CANNOT PROMISE
 *
 * Can:
 *  - "No workflow for this kind of model" — certain. It is our own registry.
 *  - "Installs into a folder the workflow's loader cannot read" — certain for a
 *    catalogue entry, because the save path is part of the install request we
 *    would send.
 *  - "The backend cannot load <file> that this workflow also needs" — as
 *    certain as `/object_info` is, which is the same source ComfyUI validates
 *    against when it rejects a prompt. This is the check that catches the T5
 *    text encoder.
 *
 * Cannot:
 *  - Promise the output is any *good*. A generic workflow on an unfamiliar
 *    checkpoint runs; whether it looks right is not a thing an API can know.
 *  - Promise it fits in VRAM. Nothing here reads the file's size against the
 *    card, and a 14B video model that runs on an A100 will OOM on a 6900 XT.
 *  - Say anything about a LoRA, VAE or ControlNet beyond "this is a support
 *    file". Whether *this* LoRA suits *that* checkpoint is a question about
 *    training data, not about files on a disk.
 *  - Answer at all when the backend is unreachable: the verdict degrades to
 *    the static half and says so. It never refuses on a failed probe — the same
 *    fail-open rule preflight uses, for the same reason.
 */

import type { CatalogueBaseClaim } from './family.js';
import type {
  JobKind,
  MissingCompanion,
  ModelRunnability,
  ModelType,
  RunnabilityStatus,
  Uuid,
} from '@comfy/shared';
import type { ObjectInfo } from '../lib/comfy.js';
import { checkGraph } from '../orchestrator/preflight.js';
import type { ComfyApiGraph, WorkflowTemplate } from '../workflows/types.js';
import { knownCapabilities, templatesFor } from '../workflows/registry.js';
import { checkpointSlotOf, type CheckpointSlot } from '../workflows/folders.js';
import { claimFromCatalogueBase, inferFamily } from './family.js';
import { folderForType } from './installs.js';
import { knownDownloadFor } from './known-downloads.js';

/**
 * The catalogue's save paths onto ComfyUI folder names.
 *
 * `save_path` is either "default" — meaning "wherever this type belongs" — or a
 * path whose *first segment* is the folder, e.g. "diffusion_models/FLUX1" or
 * "checkpoints/LTXV". Only the first segment matters: a subfolder is still
 * inside the folder the loader reads, and ComfyUI lists it as
 * `LTXV\ltx-video-2b-v0.9.1.safetensors`.
 */
export function folderForSavePath(savePath: string | null, type: ModelType): string | null {
  if (!savePath || savePath === 'default') return folderForType(type);
  const first = savePath.split(/[\\/]/)[0]?.trim();
  if (!first) return folderForType(type);
  // Manager's older rows use "unet" for what ComfyUI now calls diffusion_models.
  if (first === 'unet') return 'diffusion_models';
  return first;
}

const CAPABILITY_WORDS: Record<JobKind, string> = {
  txt2img: 'text-to-image',
  img2img: 'image-to-image',
  txt2vid: 'text-to-video',
  img2vid: 'image-to-video',
  upscale: 'upscaling',
};

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What a support file is for, in the words a person would use. */
const SUPPORT_WORDS: Partial<Record<ModelType, string>> = {
  lora: 'Adapts a checkpoint rather than generating on its own.',
  vae: 'Decodes latents, in place of the VAE inside a checkpoint.',
  controlnet: 'Steers a checkpoint from a reference image.',
  upscaler: 'Used by an upscale workflow rather than a generation one.',
  clip: 'A text encoder, for the model families that need one alongside their weights.',
};

export interface RunnabilityInput {
  /** As the file will be known to ComfyUI, subfolder and all. */
  filename: string;
  type: ModelType;
  /** The catalogue's own `base`, when there is one. Authoritative if we know it. */
  catalogueBase?: string | null;
  /** The ComfyUI folder the file is in, or will be installed into. */
  folder: string | null;
  /** `/object_info` for the backend in question, or null if we could not read it. */
  info: ObjectInfo | null;
  backendId: Uuid | null;
  /** Name used in the sentences. */
  backendName: string;
  /**
   * True for a file already on the backend. It changes one thing: a checkpoint
   * the workflow's loader cannot see is then a fact about this machine, not a
   * prediction about an install.
   */
  installed: boolean;
  /**
   * Measure against exactly these templates instead of every candidate for
   * the family. How the per-template verdicts on the Workflows sheet are
   * produced: the same judgement, one graph at a time.
   */
  templates?: readonly WorkflowTemplate[];
}

/** The template's graph with the checkpoint slot pointed at this file. */
function graphWithCheckpoint(
  template: WorkflowTemplate,
  slot: CheckpointSlot,
  filename: string,
): ComfyApiGraph {
  const node = template.graph[slot.nodeId]!;
  return {
    ...template.graph,
    [slot.nodeId]: { ...node, inputs: { ...node.inputs, [slot.input]: filename } },
  };
}

interface Attempt {
  capability: JobKind;
  templateId: string;
  isFallback: boolean;
  /** Set when this template's loader reads a different folder than the file's. */
  folderMismatch: { loader: string; wants: string } | null;
  /**
   * Set for a file already on the backend that the workflow's own loader does
   * not offer. Same problem as a folder mismatch, established the other way
   * round: not predicted from a save path but observed in `/object_info`.
   */
  notVisibleTo: string | null;
  missing: MissingCompanion[];
  missingNodeClass: string | null;
  /** True when nothing stands between this template and a run. */
  clean: boolean;
}

/**
 * The verdict for one model on one backend. Pure — the caller fetches
 * `/object_info` (through preflight's cache) and passes it in, which is what
 * makes this testable against a fixture instead of a live LAN box.
 */
export function runnabilityFor(input: RunnabilityInput): ModelRunnability {
  const family = inferFamily({ filename: input.filename, catalogueBase: input.catalogueBase });

  const base = {
    family,
    backendId: input.backendId,
    missing: [] as MissingCompanion[],
  };

  // Support files never "run". Saying so is not a dodge: it is the honest
  // answer, and it stops a grid of LoRAs from being marked unusable because no
  // template names one.
  if (input.type !== 'checkpoint') {
    return {
      ...base,
      status: 'support',
      capabilities: [],
      summary: 'Support file',
      detail: SUPPORT_WORDS[input.type] ?? 'A file a workflow uses rather than generates with.',
    };
  }

  // The catalogue states a family for every row it offers, and that statement
  // is the best evidence there is about a file nobody has downloaded yet. If we
  // cannot place it, the answer is "we have no workflow for a Stable Cascade
  // model" — *not* "we do not know what this is, here is the generic
  // Stable-Diffusion graph". The generic graph exists for unrecognised SD
  // merges; a model whose own row says PixArt or Hunyuan-DiT is not one, and
  // running it through CheckpointLoaderSimple would fail after the download.
  //
  // Measured on the live 372-entry catalogue before this gate existed: 19
  // entries — Stable Cascade, SUPIR, Hunyuan-DiT, DynamiCrafter, Depth-FM,
  // MotionCtrl, ToonCrafter, OmniGen2, PixArt-Sigma, Segmind Vega — were being
  // promised a generic run. None of them would have run.
  //
  // A `named` base overrules the filename, which is the whole point of calling
  // the catalogue authoritative. "LTX-2 19B" contains the letters "ltx", so the
  // filename rules place it in the LTX-Video family and it was being measured
  // against our LTX-Video 0.9 graph — a different node set for a different
  // model. Its row says LTX-2, and we have no LTX-2 workflow.
  //
  // This cannot misfire on an installed model: there the base we pass is
  // `models.base_model`, which is either one of our own canonical spellings
  // (`family`) or absent (`unstated`), so neither branch below is reachable and
  // an unrecognised community merge still gets the generic graph.
  const claim = claimFromCatalogueBase(input.catalogueBase);
  if (claim.kind === 'named' || (family === null && claim.kind === 'not-a-family')) {
    return {
      ...base,
      status: 'no-workflow',
      capabilities: [],
      summary: 'No workflow for this yet',
      detail:
        claim.kind === 'named'
          ? `No ${claim.stated} workflow yet — rippel cannot generate with one.`
          : 'No workflow for this kind of checkpoint yet.',
    };
  }

  // Every graph that could serve this family, not one per capability: the
  // registry can hold two specific templates for one family that differ only
  // by which folder they load the model from, and a file in
  // `diffusion_models/` has to be judged by the graph that reads that folder.
  const candidates =
    input.templates ??
    knownCapabilities().flatMap((capability) => templatesFor(capability, family));
  if (candidates.length === 0) {
    return {
      ...base,
      status: 'no-workflow',
      capabilities: [],
      summary: 'No workflow for this yet',
      detail: `No ${displayFamily(family, claim)} workflow yet — rippel cannot generate with one.`,
    };
  }

  const attempts: Attempt[] = [];
  for (const template of candidates) {
    const offer = {
      capability: template.manifest.capability,
      templateId: template.manifest.id,
      isFallback: template.manifest.isFallback === true,
    };
    const slot = checkpointSlotOf(template);

    const folderMismatch =
      slot && slot.folder && input.folder && slot.folder !== input.folder
        ? { loader: slot.nodeClass, wants: slot.folder }
        : null;

    let missing: MissingCompanion[] = [];
    let missingNodeClass: string | null = null;
    let notVisibleTo: string | null = null;

    if (input.info && slot) {
      const result = checkGraph(graphWithCheckpoint(template, slot, input.filename), input.info);
      const isSlot = (file: { nodeId: string; input: string }) =>
        file.nodeId === slot.nodeId && file.input === slot.input;

      // The model itself is never a *companion*. For a catalogue entry it is
      // not installed yet — that is the whole point of the screen — so its
      // absence proves nothing. For a file already on disk it proves a great
      // deal: this loader cannot see it.
      //
      // Except that the two sides spell the same file differently. A catalogue
      // row names `sd_xl_base_1.0.safetensors`; ComfyUI, which installed it
      // into `checkpoints/SDXL`, lists `SDXL\sd_xl_base_1.0.safetensors`. An
      // exact-match miss on an installed entry was therefore telling the user
      // that the one checkpoint on the box that definitely works could not be
      // seen. So a miss only counts when the loader offers nothing with the
      // same basename either.
      const slotMiss = result.missingFiles.find(isSlot);
      if (input.installed && slotMiss && !offersBasename(slotMiss.available, input.filename)) {
        notVisibleTo = slot.nodeClass;
      }

      missing = result.missingFiles
        .filter((file) => !isSlot(file))
        .map((file) => ({
          filename: file.filename,
          purpose: purposeOf(file.nodeClass, file.filename),
          loader: file.nodeClass,
          // With no install catalogue on the machine, the file's name alone
          // sends a person searching; the known source sends them to the file.
          source: sourceForMissing(template, file),
        }));
      missingNodeClass = result.missingNodeClasses[0] ?? null;
    }

    attempts.push({
      capability: offer.capability,
      templateId: offer.templateId,
      isFallback: offer.isFallback,
      folderMismatch,
      notVisibleTo,
      missing,
      missingNodeClass,
      clean: !folderMismatch && !notVisibleTo && missing.length === 0 && !missingNodeClass,
    });
  }

  const clean = attempts.filter((attempt) => attempt.clean);
  const capabilities = [...new Set((clean.length > 0 ? clean : attempts).map((attempt) => attempt.capability))];
  const words = listWords(capabilities.map((kind) => CAPABILITY_WORDS[kind]));

  if (clean.length > 0) {
    // The template that would run: an authored one over a generic one.
    const winner = clean.find((attempt) => !attempt.isFallback) ?? clean[0]!;
    // `/object_info` unread means the file checks did not run, so "clean" only
    // proves the static half. Say which one you are being told.
    if (!input.info) {
      return {
        ...base,
        templateId: winner.templateId,
        status: 'unknown',
        capabilities,
        summary: 'Probably runs — could not check',
        detail: `Good for ${words}, if ${input.backendName} has the other files that workflow needs — it was offline, so we could not check.`,
      };
    }
    const authored = clean.some((attempt) => !attempt.isFallback);
    return {
      ...base,
      templateId: winner.templateId,
      status: authored ? 'ready' : 'generic',
      capabilities,
      summary: authored ? 'Will run' : 'Will run, on a generic workflow',
      // About the model, not about us. The old version of the second line
      // explained our own inference — "we could not work out what family this
      // is" — which told the reader nothing they could use and was, on 19 of
      // the 372 catalogue entries, not even true.
      detail: authored
        ? `Runs on the ${displayFamily(family, claim)} workflow — ${words}.`
        : `Runs on the generic Stable Diffusion workflow — ${words}.`,
    };
  }

  // Nothing is clean. Report the *nearest* obstacle: a folder mismatch is worth
  // more than a missing companion, because it cannot be fixed by downloading
  // anything and would otherwise be reported as "install one more file".
  if (attempts.length > 0 && attempts.every((a) => a.folderMismatch || a.notVisibleTo)) {
    const mismatch = attempts.find((attempt) => attempt.folderMismatch)?.folderMismatch;
    const invisible = attempts.find((attempt) => attempt.notVisibleTo)?.notVisibleTo;
    return {
      ...base,
      templateId: attempts[0]!.templateId,
      status: 'wrong-folder',
      capabilities,
      summary: input.installed ? 'On disk, but the workflow cannot see it' : 'Lands in the wrong folder',
      detail: mismatch
        ? input.installed
          ? `It is in "${input.folder}", but the workflow loads it from "${mismatch.wants}" — it needs moving there, not downloading again.`
          : `Installs into "${input.folder}", but the workflow loads it from "${mismatch.wants}" — it would have to be moved there afterwards.`
        : `On the machine, but in a folder ${invisible} does not read — it needs moving, not downloading again.`,
    };
  }

  // Among the graphs that can at least see the file, the one missing the
  // least is the nearest to running and the one worth naming.
  const seeing = attempts.filter((attempt) => !attempt.folderMismatch && !attempt.notVisibleTo);
  const blocked = [...seeing]
    .sort((a, b) => a.missing.length - b.missing.length)
    .find((attempt) => attempt.missing.length > 0 || attempt.missingNodeClass);
  if (blocked?.missingNodeClass) {
    return {
      ...base,
      templateId: blocked.templateId,
      status: 'needs-companion',
      capabilities,
      summary: 'Needs a custom node',
      detail: `Its workflow uses the "${blocked.missingNodeClass}" node, which is not installed on ${input.backendName}.`,
    };
  }
  if (blocked) {
    const [first, ...rest] = blocked.missing;
    const more = rest.length > 0 ? ` and ${rest.length} other file${rest.length > 1 ? 's' : ''}` : '';
    return {
      ...base,
      templateId: blocked.templateId,
      status: 'needs-companion',
      capabilities,
      missing: blocked.missing,
      summary: 'Needs another model first',
      detail: `Also needs ${first!.purpose ? `a ${first!.purpose}, ${first!.filename}` : first!.filename}${more}, which ${input.backendName} does not have.`,
    };
  }

  return {
    ...base,
    templateId: attempts[0]?.templateId,
    status: 'unknown',
    capabilities,
    summary: 'Cannot tell',
    detail: `There is a workflow for it, but ${input.backendName} could not be asked what it can load.`,
  };
}

/** Last path segment, either separator: the backend may be a Windows box. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Does this loader offer the same file under a folder-qualified name?
 *
 * Only ever asked about a file we already know is on the machine — see the note
 * at the call site. Two different files sharing a basename in two subfolders
 * would both be loadable anyway, so the looser match cannot invent visibility
 * that is not there.
 */
function offersBasename(available: string[], filename: string): boolean {
  const target = basename(filename).toLowerCase();
  return available.some((option) => basename(option).toLowerCase() === target);
}

/**
 * The same vocabulary preflight uses for a missing file, kept in step with it
 * deliberately: the sentence a user reads here, before installing, should be
 * the one they would have read from a refused job.
 */
function purposeOf(nodeClass: string, filename: string): string | null {
  if (/^(CLIPLoader|DualCLIPLoader|TripleCLIPLoader)$/.test(nodeClass)) {
    return /t5/i.test(filename) ? 'T5 text encoder' : 'text encoder';
  }
  if (nodeClass === 'VAELoader') return 'VAE';
  if (/Lora/i.test(nodeClass)) return 'LoRA';
  if (/ControlNet/i.test(nodeClass)) return 'ControlNet';
  if (/Upscale/i.test(nodeClass)) return 'upscaling model';
  if (/^(CheckpointLoaderSimple|CheckpointLoader|UNETLoader)$/.test(nodeClass)) {
    return 'model checkpoint';
  }
  return null;
}

/**
 * How a family is written in a sentence.
 *
 * `models.base_model` holds folded, canonical spellings — "sdxl", "ltx-video" —
 * because that is what makes two rows comparable. They are not what anybody
 * calls these models, and "A sdxl model" in a message a user reads is a small
 * ugliness with no upside, so the display spelling is kept here.
 */
const FAMILY_NAMES: Record<string, string> = {
  sdxl: 'SDXL',
  'sdxl-turbo': 'SDXL Turbo',
  pony: 'Pony',
  illustrious: 'Illustrious',
  'sd1.5': 'SD 1.5',
  'sd2.x': 'SD 2.x',
  sd3: 'SD 3',
  'flux.1': 'FLUX.1',
  'hunyuan-video': 'Hunyuan Video',
  'ltx-video': 'LTX-Video',
  svd: 'Stable Video Diffusion',
  wan: 'WAN',
};

function familyName(family: string): string {
  return FAMILY_NAMES[family] ?? family;
}

/**
 * What to call this model's family in a sentence, best evidence first: our own
 * canonical name if we placed it, otherwise the word the catalogue used
 * ("Stable Cascade"), otherwise nothing worth saying.
 *
 * The catalogue's own spelling is deliberately preferred over silence: it is
 * what the row says, it is what the user sees in the family filter, and it is a
 * fact about the model rather than a report on our inference.
 */
function displayFamily(family: string | null, claim: CatalogueBaseClaim): string {
  if (family) return familyName(family);
  if (claim.kind === 'named' || claim.kind === 'family') return claim.stated;
  return 'generic Stable Diffusion';
}

/** For the UI's filter: the statuses that mean "this is usable as it stands". */
export function isUsable(status: RunnabilityStatus): boolean {
  return status === 'ready' || status === 'generic';
}

/**
 * Where to fetch a missing companion by hand.
 *
 * The requirement's `preferred` builds are tried before the graph's literal,
 * because the literal is frequently the build we would *not* recommend: the LTX
 * graphs name `t5xxl_fp16`, which does not fit beside the transformer on 16 GB,
 * and the requirement prefers the fp8 one. Any preferred build satisfies the
 * requirement's pattern, and the resolver rewrites the graph to whichever is
 * installed, so pointing at it is not pointing at a different workflow.
 */
function sourceForMissing(
  template: WorkflowTemplate,
  file: { nodeId: string; input: string; filename: string },
) {
  const path = `${file.nodeId}.inputs.${file.input}`;
  const requirement = (template.manifest.requires ?? []).find((r) => r.path === path);
  for (const candidate of [...(requirement?.preferred ?? []), file.filename]) {
    const source = knownDownloadFor(candidate);
    if (source) return source;
  }
  return null;
}

