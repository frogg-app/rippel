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
      'It holds diffusers-format weights (the diffusion transformer alone, laid out for the diffusers library), ' +
      'and ComfyUI has no loader for that layout — installing a prompt reader or image decoder will not change that. ' +
      'Use a ComfyUI single-file build of the model instead, such as ltx-video-2b-v0.9.1.safetensors.',
  },
  diffusionOnly: {
    summary: 'Diffusion weights only',
    detail:
      'It holds the diffusion weights alone, with no image decoder inside, so it has to load from the ' +
      '"diffusion_models" folder with a separate image decoder (VAE) and prompt reader.',
  },
} as const;
