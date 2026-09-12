/**
 * How big a job is, on one scale, so that two jobs can be compared.
 *
 * ## What this is for, and what it is emphatically not
 *
 * This is **not** a VRAM predictor. It does not know your allocator, your
 * attention implementation, whether ComfyUI decided to tile the decode, or how
 * much the driver is holding back. Anything claiming to turn a model file and a
 * resolution into "you need 11.4 GB" is guessing, and this project has already
 * been burned once by trusting a memory number (see the README on the reported
 * VRAM figure — a 16 GB card that called itself 36.5 GB).
 *
 * What it produces is an **ordering**. Given two jobs on one backend, it answers
 * "is this one bigger than that one, and by roughly how much". That is a far
 * weaker claim and it is enough for the thing we actually want, which the README
 * names as the durable fix: learning each backend's real ceiling from observed
 * outcomes. A ceiling only needs jobs to be comparable, not absolutely measured.
 *
 * So: the number has units of bytes because bytes are what it is built from, and
 * every caller should treat it as a score. `fit.ts` only ever compares it
 * against other scores recorded on the same backend.
 *
 * ## What goes into it
 *
 * Two terms, because two things dominate and everything else is noise beside
 * them.
 *
 * **Weights.** The file on disk, which we know exactly — `Model.sizeBytes`, and
 * the declared size of each companion. Weights are the floor: whatever else
 * happens, they have to be somewhere. Loaded at the dtype the file already is,
 * so a size on disk is a size in memory to within a few per cent.
 *
 * **Activations.** Proportional to the latent volume — width x height x frames
 * — because every tensor that flows through the sampler is some multiple of it.
 * The multiplier is a per-family constant rather than a derivation, and it is
 * fitted to nothing at all right now; it is an ordering, and within one family
 * the constant cancels out of every comparison that matters.
 *
 * Video is where this earns its keep. Doubling a clip's length doubles the
 * activation term and leaves the weights term alone, which is exactly the shape
 * of the real failure: the model loads fine and the decode dies.
 */

import type { GenerationParams } from '@comfy/shared';
import type { WorkflowManifest } from '../workflows/types.js';
import { videoFrameCount } from '../compiler/compile.js';

/** Bytes per latent element, per frame, before any family multiplier. */
const LATENT_BYTES = 2; // fp16 everywhere that matters

/**
 * How much bigger the working set is than the bare latent.
 *
 * Attention keeps several tensors the size of the latent alive at once, and the
 * VAE decode holds the *pixel* buffer, which is larger than the latent by the
 * compression ratio. 24 is a round number in the middle of what these two cost
 * on the families we ship; it is not measured, and it does not need to be,
 * because it is identical for every job being compared on one backend.
 */
const ACTIVATION_FACTOR = 24;

/**
 * Latent spatial compression. All the families we ship use 8x, except Wan 2.2's
 * new VAE at 16x. Getting this wrong shifts a family's whole curve up or down
 * by a constant, which — again — cancels within a family.
 */
function compressionOf(manifest: WorkflowManifest): number {
  return manifest.id.includes('wan22') ? 16 : 8;
}

export interface JobSize {
  /** The comparison score. Bytes, but read it as a score. */
  score: number;
  /** Weights the job has to hold. Exact, when we know the file sizes. */
  weightBytes: number;
  /** The part that grows with resolution and length. */
  activationBytes: number;
  /** Frames this job will actually sample, after snapping. 1 for a still. */
  frames: number;
  /** True when a file size was missing and the weight term is an underestimate. */
  partial: boolean;
}

export interface JobSizeInput {
  manifest: WorkflowManifest;
  params: GenerationParams;
  width: number;
  height: number;
  /**
   * Bytes on disk for every file this job loads: the checkpoint, each companion,
   * each LoRA. A `null` entry means we do not know that one — it is skipped and
   * `partial` goes true, because an underestimate that announces itself is
   * useful and one that does not is a trap.
   */
  fileBytes: readonly (number | null)[];
}

/**
 * Score one job.
 *
 * Batch multiplies the activation term and not the weights: a batch of four
 * shares one copy of the model. That asymmetry is most of why batching is worth
 * doing, so it would be a poor score that missed it.
 */
export function sizeOfJob(input: JobSizeInput): JobSize {
  const { manifest, params, width, height, fileBytes } = input;

  let weightBytes = 0;
  let partial = false;
  for (const bytes of fileBytes) {
    if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) {
      partial = true;
      continue;
    }
    weightBytes += bytes;
  }

  const frames = params.video ? (videoFrameCount(params, manifest) ?? 1) : 1;
  const batch = params.video ? 1 : Math.max(1, params.batchSize ?? 1);
  const compression = compressionOf(manifest);
  const latentArea = (width / compression) * (height / compression);

  const activationBytes = Math.round(
    latentArea * frames * batch * LATENT_BYTES * ACTIVATION_FACTOR,
  );

  return {
    score: weightBytes + activationBytes,
    weightBytes,
    activationBytes,
    frames,
    partial,
  };
}

/** Human-readable, for a message rather than for a comparison. */
export function formatScore(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}
