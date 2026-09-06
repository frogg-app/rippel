/**
 * The two lookup tables that turn the UI's tasteful little controls into the
 * numbers a sampler actually wants.
 *
 * The user picks an aspect-ratio chip and one of three quality buttons. They
 * never see 1024x1024, "dpmpp_2m" or cfg 6.5 unless they open the Advanced
 * drawer, and the Advanced drawer's *initial* values are exactly what these
 * tables produce — so opening it never changes the result, it only reveals it.
 */

import type { AspectRatio, QualityPreset } from '@comfy/shared';
import type { PresetDefaults, PresetTable, Resolution, ResolutionTable } from './types.js';

/**
 * SDXL-native resolution buckets.
 *
 * SDXL was trained on a fixed set of ~1 megapixel buckets. Feeding it anything
 * far off that (768x768, or a 16:9 crop at 1920 wide) produces the well-known
 * duplicated-subject and mangled-anatomy failures, so we never derive width and
 * height arithmetically from the ratio — we snap to the trained bucket instead.
 * Every value is a multiple of 64, which the VAE's 8x downsample and the UNet's
 * further 8x require; a non-multiple is silently rounded by ComfyUI and the
 * output then disagrees with the dimensions we recorded in the database.
 *
 * The ratios below are the trained buckets nearest each chip, not exact
 * fractions — 1216x832 is 1.462:1 where 3:2 is 1.5, and 1344x768 is 1.75:1 where
 * 16:9 is 1.778. That mismatch is deliberate and preferable to an off-bucket
 * exact ratio; the asset's real dimensions are what we store and display.
 */
export const SDXL_RESOLUTIONS: ResolutionTable = {
  '1:1': { width: 1024, height: 1024 },
  '3:2': { width: 1216, height: 832 },
  '2:3': { width: 832, height: 1216 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
};

/**
 * Quality presets.
 *
 * These are step/cfg pairs chosen to *feel* like Fast / Balanced / High on an
 * SDXL checkpoint rather than to be theoretically optimal:
 *
 * - `fast` uses the SDE Karras sampler at 16 steps. It converges much faster
 *   than dpmpp_2m at low step counts, which is the only thing that matters when
 *   the point is a preview in a few seconds. The lower cfg keeps it from
 *   over-baking at that step count.
 * - `balanced` is the default and the most-run path: dpmpp_2m + karras at 28
 *   steps is the SDXL community consensus for a good image in reasonable time.
 * - `high` is the same sampler further along its own convergence curve. It is
 *   deliberately *not* a different sampler, so that stepping a generation up
 *   from Balanced to High refines the same image rather than producing an
 *   unrelated one from the same seed.
 *
 * Sampler and scheduler names must match ComfyUI's KSampler enums exactly;
 * `SDXL_SAMPLERS` / `SDXL_SCHEDULERS` below are the validated list, and the
 * unit tests check these defaults are members of it.
 */
export const QUALITY_PRESETS: PresetTable = {
  fast: { steps: 16, cfg: 5.5, sampler: 'dpmpp_sde', scheduler: 'karras' },
  balanced: { steps: 28, cfg: 6.5, sampler: 'dpmpp_2m', scheduler: 'karras' },
  high: { steps: 45, cfg: 7.0, sampler: 'dpmpp_2m', scheduler: 'karras' },
};

/**
 * The sampler and scheduler names we offer in the Advanced drawer.
 *
 * ComfyUI's KSampler accepts a longer list than this. We expose a curated
 * subset because the rest are either legacy, ancestral variants that make seeds
 * non-reproducible across step counts, or research samplers that confuse more
 * than they help. The orchestrator can still cross-check against the backend's
 * `/object_info` before dispatch, but this list is what bounds the UI.
 */
export const SDXL_SAMPLERS = [
  'euler',
  'euler_ancestral',
  'heun',
  'dpm_2',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_3m_sde',
  'dpmpp_sde',
  'ddim',
  'uni_pc',
] as const;

export const SDXL_SCHEDULERS = [
  'normal',
  'karras',
  'exponential',
  'sgm_uniform',
  'simple',
  'beta',
] as const;

/**
 * Seeds are unsigned 64-bit in ComfyUI, but JavaScript numbers only hold
 * integers exactly up to 2^53-1. We cap at 2^53-1 so that a seed survives the
 * round trip through JSON, Postgres and back without silently changing — a seed
 * that does not reproduce its image is worse than a smaller seed space.
 */
export const MAX_SEED = Number.MAX_SAFE_INTEGER;

export function resolutionFor(aspect: AspectRatio): Resolution {
  return SDXL_RESOLUTIONS[aspect];
}

export function presetFor(quality: QualityPreset): PresetDefaults {
  return QUALITY_PRESETS[quality];
}

// ---------------------------------------------------------------- video

/**
 * LTX-Video resolution buckets.
 *
 * These are emphatically *not* the SDXL 1MP buckets, and reusing those is the
 * single easiest way to make video unusable on a 16 GB card. A latent video is
 * a stack: memory scales with width * height * frames, so 1024x1024 at 97
 * frames is roughly a hundred times the working set of one 1024x1024 image and
 * will exhaust any consumer card long before it finishes. Everything here sits
 * at ~0.25-0.3 MP per frame, which at 97 frames is the same order of magnitude
 * as a single SDXL image and leaves headroom for the decode.
 *
 * Every value is a multiple of 32. LTX-Video's VAE downsamples spatially by 32
 * (`EmptyLTXVLatentVideo` declares `step: 32` on both axes), so a non-multiple
 * is rounded by the node and the clip comes back a different size from the one
 * recorded on the asset row.
 *
 * 768x512 is the family's own default and the shape it was trained hardest on;
 * the buckets below are that budget redistributed across the aspect chips
 * rather than exact fractions, on the same reasoning as the SDXL table.
 */
export const LTXV_RESOLUTIONS: ResolutionTable = {
  '1:1': { width: 512, height: 512 },
  '3:2': { width: 672, height: 448 },
  '2:3': { width: 448, height: 672 },
  '16:9': { width: 704, height: 384 },
  '9:16': { width: 384, height: 704 },
};

/**
 * The samplers we offer for LTX-Video.
 *
 * Much shorter than `SDXL_SAMPLERS`, because the sigma schedule is not a free
 * choice here: `LTXVScheduler` computes its own shifted sigmas and hands them to
 * `SamplerCustom`, so all that is left to pick is the integrator. Ancestral and
 * SDE variants inject fresh noise at every step, which on a video model reads as
 * per-frame flicker rather than as variety, so they are not offered at all.
 */
export const LTXV_SAMPLERS = ['euler', 'dpmpp_2m', 'ddim'] as const;

/**
 * Quality presets for LTX-Video.
 *
 * Step counts are far lower than SDXL's and the guidance far weaker, and both
 * are properties of the model rather than of our taste: LTX-Video 2B is a
 * few-step model that has converged by ~20 steps, and Lightricks' own guidance
 * is cfg ~3. Running it at SDXL's 28 steps and cfg 6.5 gives a saturated,
 * juddering clip — which is exactly why `PresetTable` hangs off the manifest
 * instead of being one global table.
 *
 * `scheduler` is carried because `PresetDefaults` requires it, but no LTX-Video
 * template binds it: this graph has no scheduler *widget*, only the
 * `LTXVScheduler` node, which derives its sigmas from the step count and the
 * shift constants. The value below is what an Advanced drawer would show if the
 * family ever gained a scheduler control.
 */
export const LTXV_QUALITY_PRESETS: PresetTable = {
  fast: { steps: 12, cfg: 3.0, sampler: 'euler', scheduler: 'normal' },
  balanced: { steps: 20, cfg: 3.0, sampler: 'euler', scheduler: 'normal' },
  high: { steps: 30, cfg: 3.5, sampler: 'euler', scheduler: 'normal' },
};

/**
 * LTX-Video samples one key frame plus groups of eight, so a valid length is
 * `8n + 1` — 9, 17, … 97. See `frameQuantum` on `WorkflowManifest` for why a
 * length off that grid is worse than an error.
 */
export const LTXV_FRAME_QUANTUM = 8;

/**
 * The frame counts the templates will sample, at the extremes.
 *
 * The floor is one quantum: below `8n + 1` there is no clip. The ceiling is a
 * VRAM budget rather than a model limit — `EmptyLTXVLatentVideo` accepts up to
 * 16384 — picked so the largest bucket above still decodes at the longest
 * length on a 16 GB card. 161 frames is 6.4 seconds at the native 25 fps.
 */
export const LTXV_MIN_FRAMES = LTXV_FRAME_QUANTUM + 1;
export const LTXV_MAX_FRAMES = LTXV_FRAME_QUANTUM * 20 + 1;

/**
 * LTX-Video was trained at 25 fps and `LTXVConditioning` defaults to it. The
 * bounds are what stays watchable: below ~8 fps the model's own temporal
 * consistency breaks down, and above 30 the frame budget buys duration nobody
 * perceives.
 */
export const LTXV_NATIVE_FPS = 25;
export const LTXV_MIN_FPS = 8;
export const LTXV_MAX_FPS = 30;
