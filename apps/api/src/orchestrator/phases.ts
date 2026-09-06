/**
 * Turning "which node is ComfyUI running" into "what should the user be told".
 *
 * ---------------------------------------------------------------------------
 * WHAT THE BACKEND ACTUALLY SENDS — captured from ComfyUI 0.34.0 at
 * 192.168.1.10:8188 on 2026-09-06 by submitting the real txt2img-sdxl graph
 * over a WebSocket with our own clientId. Abridged, in order, warm model:
 *
 *   +0.04s execution_start   {prompt_id}
 *   +0.04s execution_cached  {nodes:["4"]}          checkpoint already loaded
 *   +0.04s progress_state    {nodes:{"5":{value:0,max:1,state:"running"}}}
 *   +0.04s executing         {node:"5"}             EmptyLatentImage
 *   +0.04s executing         {node:"7"}             negative CLIPTextEncode
 *   +0.13s executing         {node:"6"}             positive CLIPTextEncode
 *   +0.21s executing         {node:"3"}             KSampler
 *   +5.14s progress_state    {nodes:{"3":{value:1,max:8,state:"running"}}}
 *   +5.14s progress          {value:1,max:8,node:"3",prompt_id}
 *          ... one pair per step ...
 *   +7.18s progress          {value:8,max:8,node:"3"}
 *   +7.45s executing         {node:"8"}             VAEDecode
 *   +19.7s executing         {node:"9"}             SaveImage
 *   +19.7s executed          {node:"9",output:{images:[...]}}
 *   +19.7s execution_success {prompt_id}
 *   +20.0s executing         {node:null}            prompt finished
 *
 * Three things that decide the design here:
 *
 *  1. `progress_state` is new and carries every node's state; the flat
 *     `progress` frame this project was written against is still sent
 *     alongside it. Both are handled, and deduplicated, in comfy-socket.ts.
 *  2. **Twelve of the twenty seconds were the VAE decode**, with not one
 *     progress frame in it. That silence is the gap this module exists to
 *     explain, and only the `executing` node id reveals it.
 *  3. The wait before the first sampler step is *not* the checkpoint loader
 *     node. Re-running the same prompt after `POST /free` (weights evicted),
 *     node 4 still finished in 0.2s: ComfyUI's loader returns a lazy
 *     ModelPatcher and the weights actually reach the device inside the
 *     sampler, before step 1. So "preparing" has to mean *everything up to the
 *     first step*, including time spent inside the sampler node — which is
 *     exactly what the contract asks for, and why the phase is driven by
 *     "have we seen a step yet" rather than by node class alone.
 * ---------------------------------------------------------------------------
 *
 * Pure functions only: no sockets, no database. The runner owns the state and
 * asks this module what to call it.
 */

import type { JobPhase } from '@comfy/shared';

export interface PhaseContext {
  /** node id -> class_type, from the graph we compiled and submitted. */
  nodeClasses: Record<string, string>;
  /** What to call the weights being loaded, e.g. "SDXL 1.0". */
  modelLabel: string;
  /** For the "which backend is this happening on" half of a label. */
  backendName: string;
  isVideo: boolean;
  /** Images per generation; a batch is worth saying out loud. */
  batchSize: number;
  /** Frames in the clip, when we know them. */
  totalFrames: number | null;
}

// Substring, not suffix: the classes are CheckpointLoaderSimple, UNETLoader,
// CLIPLoader, LoraLoader, VAELoader. `LoadImage` deliberately does not match.
const LOADER = /Loader/;
const TEXT_ENCODE = /TextEncode/i;
const SAMPLER = /Sampler/i;
const LATENT = /Latent/i;
const DECODE = /^VAEDecode/i;
const SAVE = /^(Save|Preview)|VideoCombine|^Image(Save)?$/i;
const LOAD_IMAGE = /^LoadImage/i;
// An img2img graph spends its pre-sampling time here, not in the loader: on the
// live run the VAE encode of the starting image took 23 of the 71 seconds,
// because the checkpoint's weights are pulled in to do it.
const ENCODE_IMAGE = /^VAEEncode/i;

export function classOf(ctx: PhaseContext, nodeId: string | null): string | null {
  return nodeId === null ? null : (ctx.nodeClasses[nodeId] ?? null);
}

/** True when this node is the one that reports sampler steps. */
export function isSamplerClass(className: string | null): boolean {
  return className !== null && SAMPLER.test(className);
}

/** How many things the sampler is drawing, phrased for a person. */
function subject(ctx: PhaseContext): string {
  if (ctx.isVideo) {
    return ctx.totalFrames ? `${ctx.totalFrames} frames` : 'the clip';
  }
  return ctx.batchSize > 1 ? `${ctx.batchSize} images` : 'the image';
}

/**
 * The label for the stretch before the first sampler step.
 *
 * `nodeId` is whatever ComfyUI last said it was executing, or null when it has
 * not started on our prompt yet — which on a shared backend means somebody
 * else's job is still running, and saying so is more honest than "loading".
 */
export function preparingLabel(ctx: PhaseContext, nodeId: string | null): string {
  // Nothing executing yet is a queue on the backend, not a load — on a shared
  // box that is usually somebody else's job still running, and saying "loading"
  // would be a guess dressed up as a fact.
  if (nodeId === null) return `Queued on ${ctx.backendName}`;

  const className = classOf(ctx, nodeId);
  // A node whose class we do not know: a job re-adopted after a restart.
  if (className === null) return `Preparing on ${ctx.backendName}`;

  if (LOADER.test(className)) return `Loading ${ctx.modelLabel}`;
  if (TEXT_ENCODE.test(className)) return 'Encoding the prompt';
  if (LOAD_IMAGE.test(className)) return 'Reading the starting image';
  if (ENCODE_IMAGE.test(className)) return 'Encoding the starting image';
  if (LATENT.test(className)) return ctx.isVideo ? 'Preparing the clip' : 'Preparing the canvas';
  // Time inside the sampler before step 1 is the weights reaching the device —
  // the minutes-long wait on a cold model. See the capture above.
  if (SAMPLER.test(className)) return `Loading ${ctx.modelLabel} into memory`;
  return `Preparing on ${ctx.backendName}`;
}

export function samplingLabel(ctx: PhaseContext): string {
  return `Rendering ${subject(ctx)}`;
}

/**
 * The label for the stretch after the last step, while the backend is still
 * executing. On this hardware that is mostly the VAE, which runs on the CPU and
 * took 12 of the 20 seconds in the capture above.
 */
export function decodingLabel(ctx: PhaseContext, nodeId: string | null): string {
  const className = classOf(ctx, nodeId);
  if (className === null) return 'Finishing up';

  // "Decoding image" for one, "Decoding 4 images" for a batch: the batch is
  // four times the wait, and a user who cannot see why deserves to be told.
  if (DECODE.test(className)) {
    if (ctx.isVideo) return `Decoding ${ctx.totalFrames ? `${ctx.totalFrames} frames` : 'the clip'}`;
    return ctx.batchSize > 1 ? `Decoding ${ctx.batchSize} images` : 'Decoding image';
  }
  if (SAVE.test(className)) {
    return ctx.isVideo ? 'Encoding the video file' : `Writing the image on ${ctx.backendName}`;
  }
  if (LOADER.test(className)) return `Loading ${ctx.modelLabel}`;
  return `Finishing on ${ctx.backendName}`;
}

/** Our own download/thumbnail pass. 1-based, because a user counts from one. */
export function savingLabel(index: number, total: number): string {
  if (total <= 1) return 'Storing the result';
  return `Storing ${index} of ${total}`;
}

/**
 * The phase a job's *status* implies on its own, for rows nobody is watching
 * live — a page load, or a reconnect after the frames were missed.
 */
export function phaseForStatus(status: string): JobPhase | null {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'uploading':
      return 'saving';
    default:
      return null;
  }
}
