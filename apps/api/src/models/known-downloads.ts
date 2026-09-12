/**
 * Where to get a model file by hand, when nothing on the backend can fetch it.
 *
 * ## Why a table in the repo, and why so small
 *
 * A "Needs another model" card used to be able to point at the fix, because
 * ComfyUI-Manager's catalogue had a URL for most companion files. On 2026-09-12
 * the reference machine no longer runs Manager (`/externalmodel/getlist` 404s),
 * so the catalogue is empty and the card is left naming a file — "needs
 * umt5_xxl_fp8_e4m3fn_scaled.safetensors" — with no idea where it comes from. A
 * person then goes searching Hugging Face for a filename, and the Wan 2.1 VAE
 * sitting next to the 2.2 one in the same directory is exactly the wrong file
 * they will find.
 *
 * MODELS_PLAN names three sources for a companion's URL, in order: the workflow
 * library, the backend's install catalogue, and "a small table in the repo for
 * companions neither source covers". With the backend offline and no catalogue,
 * this is the third, and it is seeded from the first: every row below either
 * comes straight out of a library file's `properties.models` or is listed with a
 * measured size in MODELS_PLAN's install list. `known-downloads.test.ts` checks
 * the Wan rows against the real library file, so the two cannot drift apart
 * quietly.
 *
 * Add a row only with a URL somebody has opened. A wrong URL on this screen is
 * worse than none: it is followed by hand, and its failure is a silent wrong
 * file, not an error.
 *
 * ## Sizes
 *
 * Decimal gigabytes as MODELS_PLAN records them from live HTTP headers, so
 * approximate by up to half a percent. They answer "will it fit", nothing more.
 */

import type { ModelDownloadSource } from '@comfy/shared';

const WAN22_5B_LIBRARY = 'ComfyUI workflow library (video_wan2_2_5B_ti2v)';
const PLAN = 'MODELS_PLAN.md install list, sizes checked 2026-09-12';

const gb = (value: number) => Math.round(value * 1_000_000_000);

export const KNOWN_DOWNLOADS: readonly ModelDownloadSource[] = [
  {
    filename: 'wan2.2_ti2v_5B_fp16.safetensors',
    folder: 'diffusion_models',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
    approxBytes: gb(9.31),
    origin: WAN22_5B_LIBRARY,
  },
  {
    filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    folder: 'text_encoders',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    approxBytes: gb(6.27),
    origin: WAN22_5B_LIBRARY,
  },
  {
    filename: 'wan2.2_vae.safetensors',
    folder: 'vae',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors',
    approxBytes: gb(1.31),
    origin: WAN22_5B_LIBRARY,
  },
  {
    filename: 'ltx-video-2b-v0.9.5.safetensors',
    folder: 'checkpoints',
    url: 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors',
    approxBytes: gb(5.72),
    origin: PLAN,
  },
  {
    filename: 't5xxl_fp8_e4m3fn_scaled.safetensors',
    folder: 'text_encoders',
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors',
    approxBytes: gb(5.16),
    origin: PLAN,
  },
];

function basename(filename: string): string {
  return filename.split(/[\\/]/).pop()!.toLowerCase();
}

/**
 * The known source for a filename, matched on basename and case-insensitively,
 * because ComfyUI reports files with their subfolder and Windows backends with
 * backslashes. Null when the table has nothing — which the card must say plainly
 * rather than invent a search link.
 */
export function knownDownloadFor(filename: string): ModelDownloadSource | null {
  const wanted = basename(filename);
  return KNOWN_DOWNLOADS.find((entry) => entry.filename.toLowerCase() === wanted) ?? null;
}
