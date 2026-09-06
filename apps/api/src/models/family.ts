/**
 * Working out which base model family a file belongs to.
 *
 * The workflow registry is keyed by `(capability, baseModel)`: with no family
 * on a `models` row there is no template, and with the *wrong* family there is
 * a template that will happily run and produce rubbish — SDXL's resolution
 * buckets on an SD 1.5 checkpoint, or a cfg-based sampler on FLUX. A wrong
 * answer is therefore strictly worse than no answer, and everything below is
 * built around that: evidence is ranked, contradictions collapse to `null`, and
 * a name we do not recognise stays `null` rather than being nudged towards the
 * nearest-looking family.
 *
 * Two kinds of evidence exist:
 *
 *   1. The catalogue entry, when we installed the file ourselves. ComfyUI-
 *      Manager's model list states `base` outright (`ModelCatalogEntry.base`,
 *      recorded on `model_installs.base_model`), which is as authoritative as
 *      anything gets short of reading the tensors.
 *   2. The filename, including any subfolder — ComfyUI reports checkpoints as
 *      `SDXL\sd_xl_base_1.0.safetensors`, and that leading folder is often the
 *      clearest statement of family on the whole path, because a human filed it
 *      there on purpose.
 *
 * Deliberately *not* done here: opening the file. Reading the safetensors
 * header would settle most cases outright (the UNet block shapes give the
 * family away), but the files live on someone else's machine and we only ever
 * see their names over HTTP. If we ever grow a companion agent on the backend
 * host, that becomes the first-choice evidence and slots in above the two.
 */

import { normalizeBaseModel } from '../workflows/registry.js';

/**
 * The spellings we store in `models.base_model`.
 *
 * These are canonical on purpose: the registry folds case and punctuation, so
 * `sdxl` here matches a manifest that lists `SDXL 1.0`, but only one spelling
 * ever reaches the database, which keeps "group by family" in the UI honest.
 * Adding a family here without adding a template is fine and useful — the UI
 * can still group by it, and `findTemplate` simply returns undefined.
 */
export const FAMILIES = {
  sdxl: 'sdxl',
  /**
   * SDXL Turbo/Lightning are *not* folded into `sdxl`. Same node set, but they
   * want 1-8 steps at cfg ~1, and running them through the SDXL quality presets
   * (20-40 steps, cfg 7) produces a burnt image. Their own family means they
   * resolve to no template until one exists, which is the honest outcome.
   */
  sdxlTurbo: 'sdxl-turbo',
  /** SDXL derivatives: identical node set and buckets, so they share its template. */
  pony: 'pony',
  illustrious: 'illustrious',
  sd15: 'sd1.5',
  /**
   * 2.0 and 2.1 are kept together: they differ by a training run, not by node
   * set or resolution, and filenames rarely distinguish them reliably.
   */
  sd2: 'sd2.x',
  sd3: 'sd3',
  flux: 'flux.1',
  hunyuanVideo: 'hunyuan-video',
  ltxVideo: 'ltx-video',
  svd: 'svd',
  wan: 'wan',
} as const;

export type ModelFamily = (typeof FAMILIES)[keyof typeof FAMILIES];

/**
 * Derivative -> the family it is built on. Used to break the common "the name
 * mentions two families" case: `ponyDiffusionV6XL` names both Pony and SDXL,
 * and those do not contradict each other — the more specific one wins.
 * Families absent from this map are treated as mutually exclusive.
 */
const DERIVED_FROM: Partial<Record<ModelFamily, ModelFamily>> = {
  [FAMILIES.pony]: FAMILIES.sdxl,
  [FAMILIES.illustrious]: FAMILIES.sdxl,
  [FAMILIES.sdxlTurbo]: FAMILIES.sdxl,
};

/**
 * How much a match is worth. A `strong` signal names the family more or less
 * explicitly (`sdxl`, `flux`, `hunyuan_video`); a `weak` one is a convention
 * that is usually right but has no digits or family word to anchor it (a name
 * merely *ending* in "xl"). Weak signals only decide the answer when nothing
 * strong matched at all, so `dreamshaperXL` resolves but
 * `sd15_dreamshaperXL_merge` does not.
 */
type Strength = 'strong' | 'weak';

interface Rule {
  readonly family: ModelFamily;
  readonly pattern: RegExp;
  readonly strength: Strength;
}

/**
 * Patterns run against the *tokenised* name (see `tokenize`), where every
 * separator — including the path separator and the dot in a version number —
 * has become a single space and the string is padded with spaces at both ends.
 * So `SDXL\sd_xl_base_1.0.safetensors` is matched as ` sdxl sd xl base 1 0 `.
 * That is why `sd 1 5` and `sd15` both need writing out: the tokeniser splits
 * on punctuation but never inside a run of letters and digits.
 */
const RULES: readonly Rule[] = [
  // ---------------------------------------------------------------- SDXL
  { family: FAMILIES.sdxl, pattern: /\bsdxl\b/, strength: 'strong' },
  { family: FAMILIES.sdxl, pattern: /\bsd xl\b/, strength: 'strong' },
  // The stock SDXL release files, which say "xl" but never "sdxl".
  { family: FAMILIES.sdxl, pattern: /\bxl (base|refiner)\b/, strength: 'strong' },
  // The community convention of suffixing the merge name: juggernautXL,
  // dreamshaperXL. Weak: it is only ever two letters at the end of a word.
  //
  // The `[^x]` before the `xl` is load-bearing, not tidiness. Without it this
  // matched **"t5xxl"** — the T5-XXL text encoder, whose "XXL" is a parameter
  // count — and every T5 file on the catalogue was being classified as an SDXL
  // model. 18 of the live catalogue's 372 entries hit that, and an installed
  // `t5xxl_fp16.safetensors` was filed under SDXL in the models table. No real
  // XL merge ends in "xxl", so excluding that one letter costs nothing.
  { family: FAMILIES.sdxl, pattern: /\b[a-z0-9]*[^x\s]xl\b/, strength: 'weak' },

  { family: FAMILIES.sdxlTurbo, pattern: /\bsdxl (turbo|lightning)\b/, strength: 'strong' },
  // "turbo" on its own is not enough — SD-Turbo is an SD 2.1 distillation, so
  // the word only means SDXL Turbo when the name also says XL.
  { family: FAMILIES.sdxlTurbo, pattern: /\b[a-z0-9]*xl (turbo|lightning)\b/, strength: 'weak' },

  // Both are distinctive enough as bare words to be safe, and both appear
  // without "xl" in plenty of filenames.
  { family: FAMILIES.pony, pattern: /\bpony\w*\b/, strength: 'strong' },
  { family: FAMILIES.illustrious, pattern: /\billustrious\w*\b|\bilxl\b/, strength: 'strong' },
  // NoobAI is trained from Illustrious and shares its node set and buckets, so
  // it routes to the same template rather than getting a family of its own.
  { family: FAMILIES.illustrious, pattern: /\bnoobai\w*\b/, strength: 'strong' },

  // ---------------------------------------------------------------- SD 1.x / 2.x / 3
  { family: FAMILIES.sd15, pattern: /\bsd15\b|\bsd 1 5\b|\bsd 15\b/, strength: 'strong' },
  { family: FAMILIES.sd15, pattern: /\bsd1\b|\bsd 1 x\b|\bsd1x\b/, strength: 'strong' },
  // The original release artefacts: v1-5-pruned-emaonly, sd-v1-4.
  { family: FAMILIES.sd15, pattern: /\bv1 5\b|\bv1 4\b/, strength: 'weak' },

  { family: FAMILIES.sd2, pattern: /\bsd2\b|\bsd21\b|\bsd 2( [01x])?\b|\bsd2x\b/, strength: 'strong' },
  { family: FAMILIES.sd2, pattern: /\bv2 1\b|\b768 v ema\b|\b512 base ema\b/, strength: 'weak' },

  { family: FAMILIES.sd3, pattern: /\bsd3\b|\bsd3 5\b|\bsd 3( 5)?\b|\bsd3[lm]\b/, strength: 'strong' },

  // ---------------------------------------------------------------- FLUX
  // "flux" is distinctive; nothing else in the model zoo is spelt like it.
  { family: FAMILIES.flux, pattern: /\bflux\w*\b/, strength: 'strong' },

  // ---------------------------------------------------------------- video
  // Hunyuan needs the word "video": Hunyuan-DiT and HunyuanImage are image
  // models from the same lab with an entirely different graph, so a bare
  // "hunyuan" is genuinely ambiguous and gets no family.
  {
    family: FAMILIES.hunyuanVideo,
    pattern: /\bhunyuan video\b|\bhunyuanvideo\b|\bhyvideo\b|\bhunyuan\b(?=.*\bvideo\b)/,
    strength: 'strong',
  },
  { family: FAMILIES.ltxVideo, pattern: /\bltx\b|\bltxv\b|\bltx video\b/, strength: 'strong' },
  { family: FAMILIES.svd, pattern: /\bsvd\b|\bstable video diffusion\b/, strength: 'strong' },
  // Anchored on the version: "wan" on its own is too short to trust.
  { family: FAMILIES.wan, pattern: /\bwan2 [12]\b|\bwan 2 [12]\b|\bwan2[12]\b/, strength: 'strong' },
];

/**
 * What a catalogue's `base` string means, keyed by the registry's own
 * normalisation (case and punctuation stripped) so that "SD1.x", "sd1x" and
 * "SD 1.X" are one entry.
 *
 * Values that are not families at all map to `null` explicitly rather than
 * being left out: ComfyUI-Manager files upscalers under `base: "upscale"` and
 * odds and ends under `"etc"`, and we want those to fall through to the
 * filename rather than being reported as an unrecognised family.
 */
const CATALOGUE_BASES: Record<string, ModelFamily | null> = {
  sdxl: FAMILIES.sdxl,
  sdxl10: FAMILIES.sdxl,
  sdxl09: FAMILIES.sdxl,
  sdxlturbo: FAMILIES.sdxlTurbo,
  sdxllightning: FAMILIES.sdxlTurbo,
  pony: FAMILIES.pony,
  illustrious: FAMILIES.illustrious,
  illustriousxl: FAMILIES.illustrious,
  sd1x: FAMILIES.sd15,
  sd15: FAMILIES.sd15,
  sd1: FAMILIES.sd15,
  sd2x: FAMILIES.sd2,
  sd21: FAMILIES.sd2,
  sd20: FAMILIES.sd2,
  sd2: FAMILIES.sd2,
  sd3: FAMILIES.sd3,
  sd35: FAMILIES.sd3,
  flux1: FAMILIES.flux,
  flux: FAMILIES.flux,
  flux1d: FAMILIES.flux,
  flux1s: FAMILIES.flux,
  hunyuanvideo: FAMILIES.hunyuanVideo,
  hunyuanvideot2v: FAMILIES.hunyuanVideo,
  ltxv: FAMILIES.ltxVideo,
  ltxvideo: FAMILIES.ltxVideo,
  svd: FAMILIES.svd,
  stablevideodiffusion: FAMILIES.svd,
  wan21: FAMILIES.wan,
  wan22: FAMILIES.wan,
  wanvideo: FAMILIES.wan,
  // Not families. Present so they resolve to "no family" instead of falling
  // through to a guess made from a filename like `4x-UltraSharp`.
  upscale: null,
  inpaint: null,
  segmentation: null,
  embeddings: null,
  clip: null,
  clipvision: null,
  vae: null,
  etc: null,
  unknown: null,
};

/** The evidence we have about one file. Only `filename` is ever guaranteed. */
export interface FamilyEvidence {
  /**
   * As ComfyUI reports it, subfolder and all —
   * e.g. `SDXL\sd_xl_base_1.0.safetensors`. Pass the whole thing: the folder is
   * evidence, and stripping it throws away the best signal on many paths.
   */
  filename: string;
  /**
   * `ModelCatalogEntry.base` for a model we installed, as recorded on
   * `model_installs.base_model`. Authoritative when present and recognised.
   */
  catalogueBase?: string | null;
}

/**
 * Turn a reported filename into the space-separated token string the rules are
 * written against. Path separators, underscores, hyphens and dots all become
 * spaces, so a Windows subfolder is simply more tokens, and the extension is
 * dropped so `.ckpt` cannot be mistaken for a family word.
 */
function tokenize(filename: string): string {
  const withoutExtension = filename.replace(/\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i, '');
  const tokens = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  // Padded so every rule can use \b freely at either end.
  return ` ${tokens} `;
}

/** The chain of families this one is built on, nearest ancestor first. */
function ancestorsOf(family: ModelFamily): ModelFamily[] {
  const chain: ModelFamily[] = [];
  let current = DERIVED_FROM[family];
  while (current) {
    chain.push(current);
    current = DERIVED_FROM[current];
  }
  return chain;
}

/**
 * Collapse a set of matched families to one answer.
 *
 * The only set with an answer is one that forms a single line of descent: given
 * {sdxl, pony} the specific end of the chain wins, because Pony *is* an SDXL
 * model. Given {sd1.5, sdxl} there is no answer — the name contradicts itself,
 * and picking either one would silently select a wrong template.
 */
function mostSpecific(families: Set<ModelFamily>): ModelFamily | null {
  const list = [...families];
  if (list.length === 1) return list[0] ?? null;
  const leaves = list.filter((f) => {
    const ancestors = ancestorsOf(f);
    return list.every((other) => other === f || ancestors.includes(other));
  });
  return leaves.length === 1 ? (leaves[0] ?? null) : null;
}

/**
 * Infer the family from a filename alone. Exported for tests and for anywhere
 * that has no catalogue entry to offer; ordinary callers want `inferFamily`.
 */
export function familyFromFilename(filename: string): ModelFamily | null {
  const tokens = tokenize(filename);

  const strong = new Set<ModelFamily>();
  const weak = new Set<ModelFamily>();
  for (const rule of RULES) {
    if (!rule.pattern.test(tokens)) continue;
    (rule.strength === 'strong' ? strong : weak).add(rule.family);
  }

  // Weak signals never argue with strong ones — they only speak when the name
  // contains nothing explicit at all.
  if (strong.size > 0) return mostSpecific(strong);
  if (weak.size > 0) return mostSpecific(weak);
  return null;
}

/**
 * Map a catalogue's own `base` string onto our family spelling. Returns null
 * both for "this is not a family" (`upscale`) and for a string we do not
 * recognise — the caller falls back to the filename either way.
 */
export function familyFromCatalogueBase(base: string | null | undefined): ModelFamily | null {
  if (!base) return null;
  return CATALOGUE_BASES[normalizeBaseModel(base)] ?? null;
}

/**
 * What a catalogue's `base` string is *claiming*, rather than what we can do
 * with it.
 *
 * `familyFromCatalogueBase` collapses three different situations onto `null`,
 * and for inference that is right — all three mean "fall through to the
 * filename". For talking to a person they are completely different:
 *
 *   family        we recognise it: "SDXL" -> sdxl.
 *   named         it names a family we have never heard of: "Stable Cascade",
 *                 "Hunyuan-DiT", "SUPIR". This is a *statement about the
 *                 model*, and treating it as "we do not know what this is" was
 *                 a real bug — on the live catalogue 19 entries were told they
 *                 would run on the generic Stable-Diffusion graph, with the
 *                 caption "we could not work out what family this is", when
 *                 their own catalogue row said Stable Cascade or PixArt and
 *                 none of them would have run at all.
 *   not-a-family  ComfyUI-Manager files things under `base: "upscale"`, "etc",
 *                 "clip". The row is telling us it is not a generative family.
 *   unstated      no base at all. The only case where guessing is appropriate.
 *
 * Deliberately a separate function rather than a change to `inferFamily`:
 * inference feeds `models.base_model`, and making a stated-but-unknown base
 * *veto* a good filename guess there would reclassify installed files. The
 * distinction is only wanted where we are about to write a sentence.
 */
export type CatalogueBaseClaim =
  | { kind: 'family'; family: ModelFamily; stated: string }
  | { kind: 'named'; stated: string }
  | { kind: 'not-a-family'; stated: string }
  | { kind: 'unstated' };

export function claimFromCatalogueBase(base: string | null | undefined): CatalogueBaseClaim {
  const stated = base?.trim();
  if (!stated) return { kind: 'unstated' };

  const key = normalizeBaseModel(stated);
  if (Object.hasOwn(CATALOGUE_BASES, key)) {
    const family = CATALOGUE_BASES[key];
    return family ? { kind: 'family', family, stated } : { kind: 'not-a-family', stated };
  }
  return { kind: 'named', stated };
}

/**
 * The one function callers want: best available family, or null.
 *
 * Authoritative evidence beats the filename outright — when ComfyUI-Manager
 * says a file is SDXL we do not care that someone put "v1-5" in its name — but
 * only when we recognise what the catalogue said. An unknown or non-family
 * `base` falls through to the name rather than blocking inference.
 */
export function inferFamily(evidence: FamilyEvidence): ModelFamily | null {
  return familyFromCatalogueBase(evidence.catalogueBase) ?? familyFromFilename(evidence.filename);
}
