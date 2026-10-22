/**
 * Which official library workflows could run a model nothing built-in runs.
 *
 * The library (`/templates/index.json` on the backend, see
 * `library/workflows/catalogue.ts`) describes each workflow by title, tags and
 * the model names it was made for ("MiniMax H3", "Wan2.2"), never by the file a
 * person happens to have. So a match is made on words: the family's own words
 * against the entry's models, title and name, with the file's name tokens as a
 * tie-break ("r2v" in the filename prefers the reference-to-video workflow).
 *
 * This only ranks. Whether a candidate can really be added (its controls map,
 * its nodes exist, its other files have a download) is settled by converting it
 * against the backend, which the route does for the top few.
 */
import type { JobKind } from '@comfy/shared';
import type { LibraryEntry } from '../library/workflows/catalogue.js';

/**
 * The words a family goes by in the library. Absent families fall back to their
 * own spelling with punctuation as spaces, which is right for most.
 */
const FAMILY_TERMS: Record<string, readonly string[]> = {
  minimax: ['minimax', 'hailuo'],
  'qwen-image': ['qwen-image', 'qwen image'],
  hidream: ['hidream'],
  'flux.1': ['flux.1', 'flux1', 'flux'],
  'hunyuan-video': ['hunyuan video', 'hunyuanvideo'],
  'ltx-video': ['ltx-0.9', 'ltxv'],
  'wan2.2-ti2v-5b': ['wan2.2'],
  wan: ['wan'],
  sd3: ['sd3', 'sd 3'],
  sdxl: ['sdxl'],
  'sd1.5': ['sd1.5', 'sd 1.5'],
};

/** A newer model that kept the old name: "flux" must not find FLUX.2 or Flux.3. */
const LATER_GENERATION: Record<string, RegExp> = {
  'flux.1': /flux[ ._-]?[2-9]/i,
  'ltx-video': /ltx[ ._-]?[2-9]/i,
};

export function familyTerms(family: string): readonly string[] {
  return FAMILY_TERMS[family] ?? [family.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim()];
}

/** The job a library entry does, in rippel's terms, or null when it is none of ours. */
export function capabilityOf(entry: Pick<LibraryEntry, 'tags' | 'category'>): JobKind | null {
  const tags = entry.tags.map((tag) => tag.toLowerCase());
  if (tags.includes('text to video')) return 'txt2vid';
  if (tags.includes('image to video') || tags.includes('reference to video')) return 'img2vid';
  if (tags.includes('text to image')) return 'txt2img';
  if (tags.includes('upscale')) return null;
  if (/image/i.test(entry.category) && !tags.some((tag) => /video|edit|inpaint|outpaint|control/.test(tag))) return 'txt2img';
  return null;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/\.[a-z0-9]+$/, '').split(/[^a-z0-9]+/).filter((token) => token.length > 1));
}

export interface RankedEntry {
  entry: LibraryEntry;
  capability: JobKind;
  score: number;
}

/**
 * Library entries that name this family, best first. Paid cloud workflows and
 * jobs rippel does not run are left out: neither can be added.
 */
export function rankLibraryEntries(
  entries: readonly LibraryEntry[],
  model: { filename: string; family: string | null },
): RankedEntry[] {
  if (!model.family) return [];
  const terms = familyTerms(model.family);
  const later = LATER_GENERATION[model.family];
  const fileTokens = tokens(model.filename.split(/[\\/]/).pop() ?? model.filename);
  const out: RankedEntry[] = [];
  for (const entry of entries) {
    if (!entry.openSource) continue;
    const capability = capabilityOf(entry);
    if (!capability) continue;
    const named = [...entry.models, entry.title, entry.name].join(' ').toLowerCase();
    if (later && later.test(named)) continue;
    const hits = terms.filter((term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(named)).length;
    if (hits === 0) continue;
    const overlap = [...tokens(entry.name)].filter((token) => fileTokens.has(token)).length;
    out.push({ entry, capability, score: hits * 10 + overlap });
  }
  return out.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}

/**
 * The family to file an added workflow under, for a model with none: the
 * library's own model name, folded the way the registry folds families.
 */
export function familyForEntry(entry: Pick<LibraryEntry, 'models' | 'title'>): string {
  return (entry.models[0] ?? entry.title).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
}
