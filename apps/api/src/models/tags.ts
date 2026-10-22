/**
 * Sorting a model page's tags into groups.
 *
 * HuggingFace's `tags[]` is one flat list that mixes six different kinds of
 * fact with a pile of plumbing. For FLUX.1-dev it reads, in full:
 *
 *   diffusers, safetensors, text-to-image, image-generation, flux, en,
 *   license:other, endpoints_compatible, diffusers:FluxPipeline, region:us
 *
 * and a quantisation adds `base_model:quantized:black-forest-labs/FLUX.1-dev`,
 * `gguf` and `arxiv:…`. A facet built straight off that list would offer
 * "region:us" next to "photorealistic", and count `endpoints_compatible` as the
 * most popular tag in the catalogue — it is on nearly every repo.
 *
 * So this sorts each tag into one of the groups in `ModelTagGroup` and drops
 * the rest. It is a pure function with no network or database behind it, run
 * once when a model page is fetched; what is stored is the sorted result, as
 * `group:value` keys (see migration 018), so a filter can be a GIN lookup.
 *
 * The vocabularies below are deliberately closed lists rather than patterns.
 * "sd" is an ISO code (Sindhi) and also how half of Civitai abbreviates Stable
 * Diffusion; guessing that every two-letter tag is a language would put a
 * Sindhi facet on a catalogue that has never contained a word of it.
 */
import type { ModelTagGroup, ModelTags } from '@comfy/shared';

/** The order a detail view lists the groups in, and the order keys are stored. */
export const TAG_GROUPS: readonly ModelTagGroup[] = [
  'task',
  'version',
  'base',
  'library',
  'format',
  'language',
  'license',
  'tag',
];

export function emptyTags(): ModelTags {
  return { task: [], version: [], base: [], library: [], format: [], language: [], license: [], tag: [] };
}

/**
 * Tags that describe HuggingFace's hosting, not the model. Matched whole.
 * `text-generation-inference` is a serving stack, not something this studio
 * can use, and on a diffusion catalogue it only ever appears by accident.
 */
const NOISE = new Set([
  'endpoints_compatible',
  'autotrain_compatible',
  'has_space',
  'model-index',
  'custom_code',
  'text-generation-inference',
  'inference',
  'not-for-all-eyes',
  'eval-results',
]);

/** Prefixes whose whole family is plumbing or bibliography. */
const NOISE_PREFIX = /^(region|deploy|arxiv|doi|dataset|template|diffusers|endpoints|co2_eq_emissions|widget|inference):/;

/** HuggingFace's pipeline tags that a person browsing for models would filter on. */
const TASKS = new Set([
  'text-to-image',
  'image-to-image',
  'text-to-video',
  'image-to-video',
  'video-to-video',
  'unconditional-image-generation',
  'image-to-3d',
  'text-to-3d',
  'image-to-text',
  'image-text-to-text',
  'image-segmentation',
  'mask-generation',
  'depth-estimation',
  'image-classification',
  'object-detection',
  'zero-shot-image-classification',
  'image-feature-extraction',
  'feature-extraction',
  'text-to-speech',
  'text-to-audio',
  'audio-to-audio',
  'automatic-speech-recognition',
  'text-generation',
  'sentence-similarity',
  'visual-question-answering',
  'video-classification',
  'any-to-any',
]);

const LIBRARIES = new Set([
  'diffusers',
  'transformers',
  'comfyui',
  'peft',
  'timm',
  'open_clip',
  'sentence-transformers',
  'pytorch',
  'tensorflow',
  'keras',
  'jax',
  'flax',
  'mlx',
  'spandrel',
  'stable-baselines3',
  'llama.cpp',
]);

/** File formats. `gguf` is a format first: there is a library of that name, but nobody filters on it. */
const FORMATS = new Set([
  'safetensors',
  'gguf',
  'onnx',
  'ckpt',
  'pickle',
  'tensorrt',
  'coreml',
  'openvino',
  'tflite',
]);

/**
 * The ISO codes worth spelling out, written as the word a person would search
 * for. Anything outside this list stays a free tag rather than being guessed.
 */
const LANGUAGES: Record<string, string> = {
  en: 'english',
  zh: 'chinese',
  ja: 'japanese',
  ko: 'korean',
  fr: 'french',
  de: 'german',
  es: 'spanish',
  it: 'italian',
  pt: 'portuguese',
  ru: 'russian',
  ar: 'arabic',
  hi: 'hindi',
  nl: 'dutch',
  pl: 'polish',
  tr: 'turkish',
  vi: 'vietnamese',
  multilingual: 'multilingual',
};

/** The relations HuggingFace writes between `base_model:` and the repo id. */
const BASE_RELATION = /^(finetune|quantized|merge|adapter):/;

function push(tags: ModelTags, group: ModelTagGroup, value: string): void {
  const clean = value.trim().toLowerCase();
  if (!clean || tags[group].includes(clean)) return;
  tags[group].push(clean);
}

/**
 * Sort one model page's tags.
 *
 * `pipelineTag` and `license` are the page's own structured fields; they are
 * folded in first so a repo whose `tags[]` omits its task still has one, and a
 * `license:other` tag does not duplicate a licence we already hold.
 *
 * A value that already landed in a named group is not repeated as a free tag:
 * `text-to-image` is in nearly every repo's `tags[]` *and* is its pipeline tag,
 * and showing it twice on a card is the kind of noise this exists to remove.
 */
export function normaliseTags(
  raw: readonly unknown[] | null | undefined,
  known: { pipelineTag?: string | null; license?: string | null; baseModels?: readonly string[] } = {},
): ModelTags {
  const tags = emptyTags();
  if (known.pipelineTag) push(tags, 'task', known.pipelineTag);
  if (known.license) push(tags, 'license', known.license);
  for (const base of known.baseModels ?? []) push(tags, 'base', base);

  const free: string[] = [];
  for (const item of raw ?? []) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().toLowerCase();
    if (!tag || NOISE.has(tag) || NOISE_PREFIX.test(tag)) continue;

    if (tag.startsWith('base_model:')) {
      // `base_model:org/repo`, or `base_model:finetune:org/repo` and friends.
      push(tags, 'base', tag.slice('base_model:'.length).replace(BASE_RELATION, ''));
    } else if (tag.startsWith('license:')) {
      push(tags, 'license', tag.slice('license:'.length));
    } else if (tag.startsWith('language:')) {
      const code = tag.slice('language:'.length);
      push(tags, 'language', LANGUAGES[code] ?? code);
    } else if (tag.startsWith('library:')) {
      push(tags, 'library', tag.slice('library:'.length));
    } else if (TASKS.has(tag)) {
      push(tags, 'task', tag);
    } else if (LIBRARIES.has(tag)) {
      push(tags, 'library', tag);
    } else if (FORMATS.has(tag)) {
      push(tags, 'format', tag);
    } else if (LANGUAGES[tag]) {
      push(tags, 'language', LANGUAGES[tag]);
    } else if (tag.includes(':')) {
      // Some other `prefix:value` HuggingFace has invented since this was
      // written. Machine vocabulary, not a word an author chose: dropped
      // rather than shown as "foo:bar" in a list of human tags.
      continue;
    } else {
      free.push(tag);
    }
  }

  // Free tags last, once every named group is complete, so the de-duplication
  // against them is order-independent.
  const named = new Set(TAG_GROUPS.filter((g) => g !== 'tag').flatMap((g) => tags[g]));
  for (const tag of free) if (!named.has(tag)) push(tags, 'tag', tag);

  // A licence of "other" says nothing and "unknown" says less. If the page
  // named a real one as well, keep only that.
  if (tags.license.length > 1) {
    tags.license = tags.license.filter((value) => value !== 'other' && value !== 'unknown');
  }
  return tags;
}

/** Flatten to the `group:value` keys the database stores and indexes. */
export function tagKeys(tags: ModelTags): string[] {
  return TAG_GROUPS.flatMap((group) => tags[group].map((value) => `${group}:${value}`));
}

/**
 * Read stored keys back into groups. Tolerant of anything it does not
 * recognise, because a row outlives the code that wrote it.
 */
export function tagsFromKeys(keys: readonly string[] | null | undefined): ModelTags {
  const tags = emptyTags();
  for (const key of keys ?? []) {
    const cut = key.indexOf(':');
    if (cut <= 0) continue;
    const group = key.slice(0, cut) as ModelTagGroup;
    if (!TAG_GROUPS.includes(group)) continue;
    push(tags, group, key.slice(cut + 1));
  }
  return tags;
}
