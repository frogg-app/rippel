/**
 * Getting an init image from our storage onto a ComfyUI backend.
 *
 * ComfyUI's `LoadImage` does not take pixels. It takes a *name*, which it
 * resolves against the backend's own `input/` directory on that machine's disk.
 * Our uploads live in object storage on the API host, so before an img2img
 * graph can run, the bytes have to be pushed across and the graph told what the
 * file ended up being called. That is all this module does.
 *
 * It deliberately stops there: nothing here dispatches a prompt. The
 * orchestrator owns dispatch and calls {@link sendStoredInitImageToBackend}
 * (or the bytes-level {@link sendInitImageToBackend}) followed by
 * {@link withInitImage} on the compiled graph.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE BACKEND ACTUALLY DOES — verified against ComfyUI 0.34 at
 * 192.168.1.10:8188 on 2026-09-06, because every part of this is easy to get
 * wrong in a way that validates and then fails at execution.
 *
 * `POST /upload/image` is multipart/form-data with these fields:
 *
 *   image      the file part; its own filename is what the server tries to use
 *   subfolder  optional, a path *relative to* input/. Created if missing.
 *   type       optional: "input" (default), "temp" or "output".
 *   overwrite  optional; without it a name that already exists is given a
 *              " (1)" suffix and the response tells you the new name.
 *
 * The response is JSON: `{"name": "...", "subfolder": "...", "type": "input"}`.
 * Observed verbatim:
 *
 *   curl -F image=@probe.png .../upload/image
 *     -> {"name": "probe.png", "subfolder": "", "type": "input"}
 *   curl -F 'image=@probe.png;filename=cstudio-probe.png' \
 *        -F subfolder=comfy-studio -F type=input -F overwrite=true ...
 *     -> {"name": "cstudio-probe.png", "subfolder": "comfy-studio", "type": "input"}
 *
 * The name to put in `LoadImage.image` is the returned `subfolder` and `name`
 * joined with a forward slash — `"comfy-studio/cstudio-probe.png"` — and NOT
 * the bare name when a subfolder was used.
 *
 * The genuinely surprising part, and the reason this comment exists: a file in
 * a subfolder **does not appear in `LoadImage`'s combo list**. After the upload
 * above, `GET /object_info/LoadImage` still reported only
 * `['example.png', 'probe.png']` — the top level of input/ — so a graph naming
 * the subfolder path looks invalid if you check it against that list. It is
 * not. `LoadImage` declares `VALIDATE_INPUTS`, which replaces the ordinary
 * combo-membership check with an `exists_annotated_filepath()` test, and that
 * resolves relative subfolder paths. Confirmed by queuing all four of these:
 *
 *   "comfy-studio/cstudio-probe.png"          -> 200, prompt queued
 *   "probe.png"                               -> 200, prompt queued
 *   "comfy-studio/cstudio-probe.png [input]"  -> 200, prompt queued
 *   "missing.png"                             -> 400 prompt_outputs_failed_validation,
 *                                                "image - Invalid image file: missing.png"
 *
 * So a name that never made it across fails fast at `POST /prompt` with a
 * readable message rather than mid-execution. We use the plain
 * `subfolder/name` form; the `"name [input]"` annotation is only needed to
 * disambiguate the temp/output folders, which we never load from.
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { ComfyError } from '../lib/comfy.js';
import { storage, type StorageDriver } from '../storage/index.js';
import { IMG2IMG_INIT_IMAGE_NODE_ID } from './img2img-sdxl.js';
import type { ComfyApiGraph } from './types.js';

/**
 * Every image we push lands here rather than at the top of input/. It keeps our
 * files out of the list a human sees in the ComfyUI UI's LoadImage dropdown,
 * and makes "everything this API put on the box" one directory an operator can
 * inspect or sweep.
 */
export const INIT_IMAGE_SUBFOLDER = 'comfy-studio';

/** What ComfyUI's /upload/image hands back. */
interface UploadImageResponse {
  name?: string;
  subfolder?: string;
  type?: string;
}

export interface TransferredInitImage {
  /** Exactly what belongs in `LoadImage.image`. */
  reference: string;
  name: string;
  subfolder: string;
}

/**
 * Name the file by its content hash.
 *
 * Two jobs that start from the same picture then reuse one file on the backend
 * instead of filling input/ with copies, a retried dispatch overwrites itself
 * byte-identically, and — the reason it is a hash and not the upload's id — the
 * name we put on a shared LAN box leaks neither a user id nor a database key.
 */
export function contentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

function contentName(bytes: Buffer, extension: string): string {
  return `${contentHash(bytes)}.${extension.replace(/^\./, '').toLowerCase()}`;
}

/**
 * Push bytes into one backend's `input/` folder and return the name a
 * `LoadImage` node should use.
 *
 * Uploading the same content twice is a no-op as far as the graph is concerned:
 * the name is derived from the bytes and `overwrite` is set, so a re-dispatch
 * after a restart rewrites the identical file rather than creating
 * `…(1).png` and leaving the graph pointing at a name that no longer matches.
 */
export async function sendInitImageToBackend(opts: {
  backendUrl: string;
  bytes: Buffer;
  /** Storage extension of the bytes, e.g. "png". Only names the file. */
  extension?: string;
  contentType?: string;
  /** Generous by default: this is a LAN transfer of a multi-megabyte image. */
  timeoutMs?: number;
}): Promise<TransferredInitImage> {
  const extension = opts.extension ?? 'png';
  const filename = contentName(opts.bytes, extension);
  const url = `${opts.backendUrl.replace(/\/+$/, '')}/upload/image`;

  const form = new FormData();
  form.append(
    'image',
    new Blob([new Uint8Array(opts.bytes)], { type: opts.contentType ?? 'application/octet-stream' }),
    filename,
  );
  form.append('subfolder', INIT_IMAGE_SUBFOLDER);
  form.append('type', 'input');
  // Without this a repeat upload is renamed " (1)" and our graph would name a
  // file that exists but holds the previous job's image.
  form.append('overwrite', 'true');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  let body: UploadImageResponse;
  try {
    const res = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) {
      throw new ComfyError(`/upload/image returned ${res.status}`, res.status);
    }
    body = (await res.json()) as UploadImageResponse;
  } catch (err) {
    if (err instanceof ComfyError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ComfyError(`Could not upload the init image to ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  // Trust the server's answer rather than what we asked for: it is the side
  // that decides the final name, and a mismatch here is exactly the bug that
  // produces a graph which validates and then loads the wrong picture.
  const name = body.name;
  if (!name) {
    throw new ComfyError(`/upload/image gave no filename back: ${JSON.stringify(body)}`);
  }
  const subfolder = body.subfolder ?? '';
  return { name, subfolder, reference: subfolder ? `${subfolder}/${name}` : name };
}

/** The same thing, starting from a key in our own object storage. */
export async function sendStoredInitImageToBackend(opts: {
  backendUrl: string;
  storageKey: string;
  contentType?: string;
  timeoutMs?: number;
  driver?: StorageDriver;
}): Promise<TransferredInitImage> {
  const driver = opts.driver ?? storage();
  const bytes = await driver.get(opts.storageKey);
  return sendInitImageToBackend({
    backendUrl: opts.backendUrl,
    bytes,
    extension: opts.storageKey.split('.').pop() ?? 'png',
    ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

/**
 * Return a copy of a compiled img2img graph with its LoadImage pointed at
 * `reference` (the `reference` field of a {@link TransferredInitImage}).
 *
 * Copy rather than mutate, for the same reason the compiler clones: a graph may
 * be shared, and a template certainly is.
 */
export function withInitImage(
  graph: ComfyApiGraph,
  reference: string,
  nodeId: string = IMG2IMG_INIT_IMAGE_NODE_ID,
): ComfyApiGraph {
  const node = graph[nodeId];
  if (!node) {
    throw new Error(`Graph has no init-image node "${nodeId}"; it is not an img2img graph.`);
  }
  if (node.class_type !== 'LoadImage') {
    throw new Error(`Node "${nodeId}" is a ${node.class_type}, not a LoadImage.`);
  }
  return {
    ...graph,
    [nodeId]: { ...node, inputs: { ...node.inputs, image: reference } },
  };
}
