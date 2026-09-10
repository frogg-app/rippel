/**
 * How a model family is spelled when a person reads it.
 *
 * `/api/models` returns families already folded to a comparable key — "sdxl",
 * "ltx-video", "svd" — because that is what makes two rows match. Those keys
 * are not what anybody calls these models, and the screens were title-casing
 * them word by word, which produced "Sdxl", "Ltx Video" and "Svd" in headings
 * the owner reads every day.
 *
 * This is the client's half of the same job `prettyModelName` does in
 * `apps/api/src/lib/comfy.ts`, and it is built the same way: a map of tokens
 * whose casing cannot be derived, then a title-case fallback for everything
 * else. It lives in `lib/` rather than in either screen because the Models page
 * and the Create screen's LoRA picker both have the fault and must not fix it
 * twice — two maps would drift, and then "SDXL" on one screen would be "SD XL"
 * on the next.
 *
 * Deliberately tolerant of which vocabulary it is handed: the folded API key
 * ("ltx-video"), the catalogue's own spelling ("LTX-Video"), and a raw
 * `base_model` string all arrive here from somewhere, and all three must come
 * out as one spelling.
 */

/**
 * Whole families whose display name is not a mechanical transform of the key.
 * Keyed by the *folded* form — lowercase, punctuation stripped — so every
 * spelling of the same family lands on one entry.
 */
const FAMILY_NAMES: Record<string, string> = {
  sdxl: 'SDXL',
  sdxlturbo: 'SDXL Turbo',
  sdxllightning: 'SDXL Lightning',
  sd15: 'SD 1.5',
  sd1x: 'SD 1.x',
  sd2x: 'SD 2.x',
  sd21: 'SD 2.1',
  sd3: 'SD 3',
  sd35: 'SD 3.5',
  flux1: 'FLUX.1',
  flux: 'FLUX',
  ltxvideo: 'LTX-Video',
  ltxv: 'LTXV',
  ltx2: 'LTX-2',
  hunyuanvideo: 'Hunyuan Video',
  hunyuandit: 'Hunyuan-DiT',
  svd: 'SVD',
  wan: 'WAN',
  pony: 'Pony',
  illustrious: 'Illustrious',
  stablecascade: 'Stable Cascade',
  pixartsigma: 'PixArt-Sigma',
  pixartalpha: 'PixArt-Alpha',
  auraflow: 'AuraFlow',
  kolors: 'Kolors',
  playgroundv25: 'Playground v2.5',
  upscale: 'Upscale',
  unclassified: 'Unclassified',
  unknown: 'Unknown',
};

/**
 * Single words inside a family name whose casing is not title case. Same
 * intent as the API's `CASED_TOKENS`, kept short: this only ever sees family
 * strings, not arbitrary filenames.
 */
const CASED_TOKENS: Record<string, string> = {
  sd: 'SD',
  sdxl: 'SDXL',
  xl: 'XL',
  ltx: 'LTX',
  ltxv: 'LTXV',
  svd: 'SVD',
  vae: 'VAE',
  clip: 'CLIP',
  lora: 'LoRA',
  flux: 'FLUX',
  wan: 'WAN',
  dit: 'DiT',
  gguf: 'GGUF',
  esrgan: 'ESRGAN',
  ai: 'AI',
  '3d': '3D',
  controlnet: 'ControlNet',
  hunyuan: 'Hunyuan',
  pixart: 'PixArt',
};

/** Lowercase, letters and digits only — the key both vocabularies fold onto. */
function fold(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The display spelling of one family.
 *
 * Falls back to a token-wise title case, so a family nobody has mapped yet —
 * a community merge, a model released last week — still reads as words rather
 * than as a database key, and adding it to the map later only improves it.
 */
export function familyDisplayName(family: string | null | undefined): string {
  if (!family) return 'Unclassified';
  const known = FAMILY_NAMES[fold(family)];
  if (known) return known;

  return family
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => {
      const cased = CASED_TOKENS[word.toLowerCase()];
      if (cased) return cased;
      // "sd15", "sdxl1.0", "ltx2" — an acronym with a version glued on, which
      // title case would render "Sd15".
      const versioned = /^([a-z]+)([\d.]+)$/i.exec(word);
      if (versioned) {
        const stem = CASED_TOKENS[versioned[1]!.toLowerCase()];
        if (stem) return stem + ' ' + versioned[2]!;
      }
      return word.replace(/^\w/, (character) => character.toUpperCase());
    })
    .join(' ');
}
