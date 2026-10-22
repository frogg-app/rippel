/**
 * What is actually *inside* a model file, read off its safetensors header.
 *
 * Every other check in this directory judges a file by its name, its folder and
 * what `/object_info` lists. None of them can tell two files apart that share
 * all three, and the case that made this module necessary is exactly that:
 *
 *   `Muinez/ltxvideo-2b-nsfw/model_weights_0306.safetensors`, installed into
 *   `checkpoints/` on steve-pc, family LTX-Video, T5 present. Every check
 *   passed, the card said "Will run", and ComfyUI answered
 *   `CheckpointLoaderSimple: ERROR: Could not detect model type`.
 *
 * Its header says why. Its 715 tensors are named `transformer_blocks.N…`,
 * `time_embed.…`, `proj_in.…`, `caption_projection.…` — the diffusers library's
 * names for the LTX transformer, alone: no VAE, no text encoder, and none of
 * the `model.diffusion_model.` / `adaln_single` / `patchify_proj` names
 * ComfyUI's model detection looks for. ComfyUI converts diffusers layouts for
 * AuraFlow, PixArt, Flux, SD3 and Z-Image (`convert_diffusers_mmdit` in
 * `comfy/model_detection.py`) and for nothing else, so no loader it ships can
 * read this file from any folder. The official single-file build,
 * `ltx-video-2b-v0.9.1.safetensors`, has `model.diffusion_model.*` and `vae.*`
 * side by side, which is what `CheckpointLoaderSimple` expects.
 *
 * The header is the first 8 + N bytes of the file, so two small range requests
 * answer the question for a 7.7 GB download without downloading it.
 */
import { FAMILIES, type ModelFamily } from './family.js';

/**
 *  - `bundled`: diffusion weights and a VAE in one file — what
 *    `CheckpointLoaderSimple` loads.
 *  - `diffusion-only`: the diffusion weights in a layout ComfyUI recognises, and
 *    nothing else. Loads through `UNETLoader` from `diffusion_models/`, with
 *    the image decoder (and prompt reader) as separate files.
 *  - `diffusers`: diffusers-library names that ComfyUI has no converter for.
 *    No workflow can run it, whatever is installed beside it.
 *  - `unknown`: we could not read it, or it is something we do not recognise.
 *    Never a reason to refuse anything.
 */
export type WeightsLayout = 'bundled' | 'diffusion-only' | 'diffusers' | 'unknown';

export const WEIGHTS_LAYOUTS: readonly WeightsLayout[] = ['bundled', 'diffusion-only', 'diffusers', 'unknown'];

/** Prefixes a full checkpoint uses for the VAE half. */
const VAE_PREFIXES = ['vae.', 'first_stage_model.'];

/**
 * Tensor names that only appear in ComfyUI-native (or original-repo) diffusion
 * weights, which ComfyUI's detection reads directly: LTX's `adaln_single` and
 * `patchify_proj`, FLUX/Hunyuan's `double_blocks`, SD3's `joint_blocks`, and a
 * diffusers SD UNet's `down_blocks`, which `UNETLoader` does convert.
 */
const NATIVE_MARKERS = ['adaln_single.', 'patchify_proj.', 'double_blocks.', 'joint_blocks.', 'down_blocks.', 'input_blocks.'];

export function classifyWeightKeys(keys: readonly string[]): WeightsLayout {
  if (keys.length === 0) return 'unknown';
  const has = (prefix: string) => keys.some((key) => key.startsWith(prefix));

  if (has('model.diffusion_model.')) {
    return VAE_PREFIXES.some(has) ? 'bundled' : 'diffusion-only';
  }

  // The diffusers LTX transformer: `time_embed` where ComfyUI expects
  // `adaln_single`, `proj_in` where it expects `patchify_proj`. Checked before
  // the native markers so that a file with both is not waved through.
  if (has('transformer_blocks.') && has('time_embed.') && has('proj_in.') && !has('adaln_single.')) {
    return 'diffusers';
  }

  if (NATIVE_MARKERS.some(has)) return 'diffusion-only';
  return 'unknown';
}

/** The header is JSON; anything bigger than this is not a header we want. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

/**
 * Tensor names from a remote safetensors file, by range request. Null when the
 * server will not serve a range, the file is not safetensors, or anything else
 * goes wrong — a failed probe is "unknown", never a verdict.
 */
export async function readSafetensorsKeys(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<string[] | null> {
  if (!/\.safetensors(\?|$)/i.test(url)) return null;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const head = await fetchImpl(url, { headers: { Range: 'bytes=0-7' }, redirect: 'follow', signal });
    if (head.status !== 206) return null;
    const lengthBytes = new Uint8Array(await head.arrayBuffer());
    if (lengthBytes.length < 8) return null;
    const length = Number(new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 8).getBigUint64(0, true));
    if (!Number.isFinite(length) || length <= 2 || length > MAX_HEADER_BYTES) return null;

    const body = await fetchImpl(url, { headers: { Range: `bytes=8-${7 + length}` }, redirect: 'follow', signal });
    if (body.status !== 206) return null;
    const header = JSON.parse(await body.text()) as Record<string, unknown>;
    return Object.keys(header).filter((key) => key !== '__metadata__');
  } catch {
    return null;
  }
}

/** One sentence per layout that blocks something, for verdicts and refusals. */
export const LAYOUT_WORDS = {
  diffusers: {
    summary: 'ComfyUI can’t load this file',
    detail:
      'ComfyUI can’t read this file’s format. Use a single-file ComfyUI build instead.',
  },
  diffusionOnly: {
    summary: 'Diffusion weights only',
    detail:
      'Move it to the diffusion_models folder; it also needs an image decoder.',
  },
} as const;

/**
 * Which family the tensor names belong to, when they say so unambiguously.
 *
 * Only names are read, never shapes, so a family whose sizes share one set of
 * names (Wan 2.2 5B and 14B, SD 2.0 and 2.1) is answered at the level the names
 * can settle, and anything that could be two things is null. A wrong family
 * routes a file to a graph that runs and makes noise; null only says "unknown".
 * The markers are the ones ComfyUI's own `model_detection.py` keys on.
 */
export function familyFromWeightKeys(keys: readonly string[]): ModelFamily | null {
  if (keys.length === 0) return null;
  const has = (prefix: string) => keys.some((key) => key.startsWith(prefix) || key.startsWith(`model.diffusion_model.${prefix}`));
  // A whole checkpoint names its text encoder, which separates the SD lines.
  if (keys.some((key) => key.startsWith('conditioner.embedders.1.'))) return FAMILIES.sdxl;
  if (keys.some((key) => key.startsWith('cond_stage_model.transformer.'))) return FAMILIES.sd15;
  if (keys.some((key) => key.startsWith('cond_stage_model.model.'))) return FAMILIES.sd2;

  // Audio-video LTX-2 shares LTX-Video's names and adds its own.
  if (has('adaln_single.') && has('patchify_proj.')) return has('audio_') || has('av_') ? null : FAMILIES.ltxVideo;
  if (has('joint_blocks.') && has('x_embedder.')) return FAMILIES.sd3;
  if (has('double_stream_blocks.')) return FAMILIES.hidream;
  if (has('transformer_blocks.0.img_mod.') && has('txt_norm.')) return FAMILIES.qwenImage;
  if (has('patch_embedding.') && has('head.modulation') && has('blocks.0.self_attn.')) return FAMILIES.wan;
  if (has('double_blocks.') && has('single_blocks.')) {
    // HunyuanVideo has FLUX's block names plus a token refiner; FLUX.2 and
    // Chroma add their own modulation layers; HunyuanImage adds a ByT5 input.
    if (has('double_stream_modulation_img') || has('distilled_guidance_layer.') || has('byt5_in.')) return null;
    if (has('txt_in.individual_token_refiner.')) return FAMILIES.hunyuanVideo;
    return has('img_in.') ? FAMILIES.flux : null;
  }
  // A UNet: SDXL's has a class embedding (label_emb); SVD's adds temporal layers.
  if (has('input_blocks.') && has('label_emb.')) return keys.some((key) => key.includes('time_stack.') || key.includes('time_mixer')) ? null : FAMILIES.sdxl;
  return null;
}
