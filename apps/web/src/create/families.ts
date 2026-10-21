/**
 * What a model family is *for*, in words somebody new can choose by.
 *
 * A tile that says "sd_xl_base_1.0.safetensors" asks the reader to already
 * know what SDXL is. Most people choosing a model want the opposite question
 * answered: "which of these is good at what I am about to ask for, and how
 * long will I wait?" The family decides most of that — every SDXL checkpoint
 * is roughly as fast as every other — so the answer is a table keyed by
 * family, not something read off each file.
 *
 * Keyed by the folded family (lowercase, letters and digits only), the same
 * key `lib/family.ts` uses, so "ltx-video", "LTX-Video" and "ltxv" land on one
 * row. A family missing from the table is not an error: it degrades to its
 * display name with no hint, which is what the tile said before this existed.
 *
 * The wording is deliberately soft ("good for", "quick", "slow") — these are
 * tendencies of a family on ordinary hardware, not measurements of this box.
 */
import { familyDisplayName } from '../lib/family';

export type Speed = 'fast' | 'medium' | 'slow';

export interface FamilyWords {
  /** The name people use for it: "Stable Diffusion XL", not "sdxl". */
  label: string;
  /** One short line: what it is good at. Null when we do not know. */
  goodFor: string | null;
  speed: Speed | null;
}

export const SPEED_WORDS: Record<Speed, string> = {
  fast: 'Quick',
  medium: 'Moderate speed',
  slow: 'Slow, best on a big graphics card',
};

const FAMILIES: Record<string, Omit<FamilyWords, 'label'> & { label: string }> = {
  sd15: { label: 'Stable Diffusion 1.5', goodFor: 'Quick sketches and a huge range of community styles', speed: 'fast' },
  sd1x: { label: 'Stable Diffusion 1.x', goodFor: 'Quick sketches and a huge range of community styles', speed: 'fast' },
  sd2x: { label: 'Stable Diffusion 2', goodFor: 'General pictures at modest sizes', speed: 'fast' },
  sd21: { label: 'Stable Diffusion 2.1', goodFor: 'General pictures at modest sizes', speed: 'fast' },
  sdxl: { label: 'Stable Diffusion XL', goodFor: 'Detailed, all-round pictures — photos, art, illustration', speed: 'medium' },
  sdxlturbo: { label: 'SDXL Turbo', goodFor: 'Near-instant drafts to try ideas quickly', speed: 'fast' },
  sdxllightning: { label: 'SDXL Lightning', goodFor: 'Fast pictures in a handful of passes', speed: 'fast' },
  pony: { label: 'Pony', goodFor: 'Cartoon, anime and character art', speed: 'medium' },
  illustrious: { label: 'Illustrious', goodFor: 'Anime and illustration', speed: 'medium' },
  sd3: { label: 'Stable Diffusion 3', goodFor: 'Pictures that follow long prompts and include text', speed: 'medium' },
  sd35: { label: 'Stable Diffusion 3.5', goodFor: 'Pictures that follow long prompts and include text', speed: 'medium' },
  flux: { label: 'FLUX', goodFor: 'Lifelike photos, hands and readable text in pictures', speed: 'slow' },
  flux1: { label: 'FLUX.1', goodFor: 'Lifelike photos, hands and readable text in pictures', speed: 'slow' },
  kolors: { label: 'Kolors', goodFor: 'Bright, photographic pictures', speed: 'medium' },
  playgroundv25: { label: 'Playground v2.5', goodFor: 'Vivid, polished artwork', speed: 'medium' },
  pixartsigma: { label: 'PixArt-Σ', goodFor: 'Large, detailed pictures from long prompts', speed: 'medium' },
  auraflow: { label: 'AuraFlow', goodFor: 'Pictures that follow the prompt closely', speed: 'slow' },
  ltxvideo: { label: 'LTX-Video', goodFor: 'Short video clips, quickly', speed: 'fast' },
  ltxv: { label: 'LTX-Video', goodFor: 'Short video clips, quickly', speed: 'fast' },
  ltx2: { label: 'LTX-2', goodFor: 'Video clips with sound and motion', speed: 'medium' },
  wan: { label: 'Wan', goodFor: 'Smooth, lifelike video clips', speed: 'slow' },
  wan21: { label: 'Wan 2.1', goodFor: 'Smooth, lifelike video clips', speed: 'slow' },
  wan22: { label: 'Wan 2.2', goodFor: 'Smooth, lifelike video with steady motion', speed: 'slow' },
  hunyuanvideo: { label: 'Hunyuan Video', goodFor: 'High-quality, cinematic video clips', speed: 'slow' },
  svd: { label: 'Stable Video Diffusion', goodFor: 'Bringing a still picture to life', speed: 'medium' },
};

function fold(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The words for one family. Never throws and never returns an empty label:
 * an unclassified model still has to be called *something* on its tile.
 */
export function familyWords(family: string | null | undefined): FamilyWords {
  if (!family) return { label: 'Unknown kind of model', goodFor: null, speed: null };
  const known = FAMILIES[fold(family)];
  if (known) return known;
  return { label: familyDisplayName(family), goodFor: null, speed: null };
}

/** "Detailed, all-round pictures · Moderate speed" — or null with nothing to say. */
export function familyHint(family: string | null | undefined): string | null {
  const words = familyWords(family);
  const parts = [words.goodFor, words.speed ? SPEED_WORDS[words.speed] : null].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}
