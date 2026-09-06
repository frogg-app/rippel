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
