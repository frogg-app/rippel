/**
 * A short, hand-kept list of models that are known to work well for most
 * people, per job. They get a "Recommended" badge and sort first within their
 * intent — but only when they will actually work on the machine being browsed
 * (see `isRecommendedHere`): a recommendation for a file this backend cannot
 * run or cannot install would be worse than none.
 *
 * Why a list in the front end rather than a field from the API: it is an
 * editorial opinion, not a fact about a backend, and it changes when a better
 * model comes along rather than when a machine does. Keeping it here, as data,
 * means changing it is a one-line diff anyone can review.
 *
 * Matching is by pattern over the entry's name, filename and model page, all
 * lower-cased, so the same model offered by ComfyUI-Manager and found on
 * Hugging Face is recognised either way. Keep patterns specific enough not to
 * catch fine-tunes that merely mention the base ("sdxl" alone would match
 * hundreds of add-ons; the type check guards the rest).
 *
 * To add one: a `label` for humans, the `intent` it is recommended for, the
 * `types` it can be, and a `pattern`. The tests in intents.test.ts pin the
 * expected matches.
 */
import type { ModelCatalogEntry, ModelType } from '@comfy/shared';
import { VOCABULARY } from './vocabulary';
import type { Intent } from './intents';

export interface Recommendation {
  label: string;
  intent: Exclude<Intent, 'all'>;
  types: readonly ModelType[];
  pattern: RegExp;
}

export const RECOMMENDED: readonly Recommendation[] = [
  // Make images: the SDXL family runs on modest cards and has workflows for
  // both making and editing; FLUX.1 schnell is the fast, permissive FLUX.
  { label: 'SDXL base', intent: 'images', types: ['checkpoint'], pattern: /sd_xl_base|stable-diffusion-xl-base|sdxl base/ },
  { label: 'Juggernaut XL', intent: 'images', types: ['checkpoint'], pattern: /juggernaut[\s_-]?xl/ },
  { label: 'DreamShaper XL', intent: 'images', types: ['checkpoint'], pattern: /dreamshaper[\s_-]?xl/ },
  { label: 'SDXL Lightning', intent: 'images', types: ['checkpoint'], pattern: /sdxl[\s_-]?lightning/ },
  { label: 'FLUX.1 schnell', intent: 'images', types: ['checkpoint'], pattern: /flux[\s._-]?1?[\s._-]?schnell/ },
  // Make video: the two that fit on a single consumer card.
  { label: 'LTX-Video', intent: 'video', types: ['checkpoint'], pattern: /ltx[\s_-]?video|ltxv/ },
  { label: 'Wan 2.2 TI2V 5B', intent: 'video', types: ['checkpoint'], pattern: /wan[\s._-]?2[._]?2.*ti2v.*5b/ },
  // Enlarge: the two everyone reaches for first.
  { label: '4x-UltraSharp', intent: 'enlarge', types: ['upscaler'], pattern: /4x[\s_-]?ultrasharp/ },
  { label: 'RealESRGAN', intent: 'enlarge', types: ['upscaler'], pattern: /real[\s_-]?esrgan/ },
];

function haystack(entry: ModelCatalogEntry): string {
  return [entry.name, entry.filename, entry.reference ?? '', entry.info?.referenceUrl ?? '']
    .join(' ')
    .toLowerCase();
}

/** The list entry this catalogue entry is, or null. */
export function recommendationFor(entry: ModelCatalogEntry): Recommendation | null {
  const text = haystack(entry);
  return RECOMMENDED.find((rec) => rec.types.includes(entry.type) && rec.pattern.test(text)) ?? null;
}

/**
 * On the list *and* able to work here: installable, and — for a model that
 * generates — with a verdict that says it runs. An enlarger has no verdict of
 * its own, so being installable is enough.
 */
export function isRecommendedHere(entry: ModelCatalogEntry): boolean {
  if (entry.installBlockedReason) return false;
  if (!recommendationFor(entry)) return false;
  if (VOCABULARY[entry.type].group !== 'models') return true;
  const status = entry.runnability?.status;
  return status === 'ready' || status === 'generic';
}
