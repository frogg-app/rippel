/**
 * Which files in a Hugging Face repository are a model you can install.
 *
 * A Hub repository is not a file. One holds a model's full weights beside a
 * smaller fp8 build and an example LoRA; another holds a ladder of GGUF
 * quantisations; a third is a Diffusers folder tree ComfyUI cannot load at all.
 * The catalogue used to treat every repository as uninstallable for exactly
 * that reason. This module reads the repository's file list (which the Hub
 * listing already returns, so it costs no extra request) and keeps the single
 * files ComfyUI loads, labelled the way the version picker shows them.
 *
 * What is kept, for a model repository:
 *  - `.safetensors` and `.gguf` at the top level, or in Comfy-Org's
 *    `split_files/<folder>/` layout;
 *  - not shards (`-00001-of-00006`), not pickles (`.ckpt`, `.bin`, `.pt`),
 *    not Apple MLX, NVFP4, INT4/INT8 or SVDQuant builds (no stock loader reads
 *    them), and not the side files a model repository carries — its VAE, its
 *    text encoder, an example LoRA, an inpainting or ControlNet build.
 *
 * Everything here is pure, so it is tested against real repository listings.
 */
import type { ModelType, ModelVariant } from '@comfy/shared';
import { FAMILIES, NEXT_GENERATION, familyFromFilename, type ModelFamily } from './family.js';

/** Comfy-Org's repositories keep each file under the folder it belongs in. */
const SPLIT_FOLDERS: Partial<Record<ModelType, readonly string[]>> = {
  checkpoint: ['diffusion_models', 'checkpoints'],
  lora: ['loras'],
  vae: ['vae'],
};

const SHARD = /-\d{5}-of-\d{5}/;

/** Builds no stock ComfyUI loader reads, whatever the repository. */
const UNLOADABLE = /(^|[^a-z0-9])(mlx|nvfp4|fp4|int4|int8|w4a4|w4a8|w8a8|w4a16|qnn|svdq|svdquant|awq|gptq|convrot|bnb|nf4|onnx|openvino|coreml)([^a-z0-9]|$)/;

/**
 * Side files in a *model* repository: the parts that come with a model rather
 * than the model itself, and other builds for other jobs.
 */
const NOT_THE_MODEL =
  /(^|[^a-z0-9])(lora|loras|lycoris|vae|ae|text[-_]?encoders?|t5|t5xxl|umt5|umt5xxl|clip|clip[-_]?[lgh]|clip[-_]?vision|mmproj|controlnet|ip[-_]?adapter|inpaint|inpainting|refiner|taesd|taef1|preview|embeddings?|upscaler?)([^a-z0-9]|$)|diffusion_pytorch_model|pytorch_lora_weights|_diffusers\b/;

const GGUF_LEVEL = /(?:^|[-_.])(I?Q\d(?:_K)?(?:_(?:XXS|XS|XL|S|M|L|0|1))?|BF16|F16|F32)(?=[-_.]|$)/i;
const DISTILLED = /distil|schnell|turbo|lightning|hyper|lcm|dmd|flash|\d+[-_]?steps?(?![a-z])/;

function stem(filename: string): string {
  return filename.replace(/\.(safetensors|gguf)$/i, '');
}

function precisionOf(filename: string): { kind: ModelVariant['kind']; precision: string | null } {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gguf')) {
    const level = GGUF_LEVEL.exec(stem(filename));
    return { kind: 'gguf', precision: level ? level[1]!.toUpperCase() : null };
  }
  if (/fp8|e4m3|e5m2|float8|(^|[^a-z0-9])f8([^a-z0-9]|$)/.test(lower)) return { kind: 'fp8', precision: 'fp8' };
  if (/bf16/.test(lower)) return { kind: 'full', precision: 'bf16' };
  if (/fp16|(^|[^a-z0-9])f16([^a-z0-9]|$)|half/.test(lower)) return { kind: 'full', precision: 'fp16' };
  if (/fp32|(^|[^a-z0-9])f32([^a-z0-9]|$)/.test(lower)) return { kind: 'full', precision: 'fp32' };
  return { kind: 'full', precision: null };
}

/** The installable files in a repository, best first. */
export function weightVariants(paths: readonly string[], type: ModelType): ModelVariant[] {
  const splitFolders = SPLIT_FOLDERS[type] ?? [];
  const out: ModelVariant[] = [];
  for (const path of paths) {
    const parts = path.split('/');
    const filename = parts[parts.length - 1]!;
    const lower = filename.toLowerCase();
    const topLevel = parts.length === 1;
    const split = parts.length === 3 && parts[0] === 'split_files' && splitFolders.includes(parts[1]!);
    if (!topLevel && !split) continue;
    if (!/\.(safetensors|gguf)$/.test(lower)) continue;
    if (SHARD.test(lower) || UNLOADABLE.test(lower)) continue;
    // A LoRA or VAE is never a GGUF in a stock loader's eyes.
    if (type !== 'checkpoint' && lower.endsWith('.gguf')) continue;
    if (type === 'checkpoint' && NOT_THE_MODEL.test(lower)) continue;
    const { kind, precision } = precisionOf(filename);
    out.push({ path, filename, kind, precision, distilled: DISTILLED.test(lower) });
  }
  return out.sort((a, b) => rank(a) - rank(b) || a.filename.length - b.filename.length || a.filename.localeCompare(b.filename));
}

/**
 * GGUF levels from the one most people should take down to the smallest.
 * Q8 is all but indistinguishable from the full weights; below Q4 the
 * pictures visibly suffer, so those are offered but never preferred.
 */
const GGUF_ORDER = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q5_K_S', 'Q5_1', 'Q5_0', 'Q4_K_M', 'Q4_K_S', 'Q4_1', 'Q4_0', 'F16', 'BF16', 'Q3_K_L', 'Q3_K_M', 'Q3_K_S', 'Q3_K', 'Q2_K', 'F32'];

function rank(variant: ModelVariant): number {
  let score: number;
  if (variant.kind === 'full') score = variant.precision === 'fp32' ? 20 : variant.precision === null ? 11 : 10;
  else if (variant.kind === 'fp8') score = 30;
  else {
    const at = GGUF_ORDER.indexOf(variant.precision ?? '');
    score = 40 + (at < 0 ? GGUF_ORDER.length : at);
  }
  // The base model before its fewer-step cousin, when a repository has both;
  // and SD 1.5's "emaonly" file, which is the one meant for generating.
  if (variant.distilled) score += 0.5;
  if (/emaonly/i.test(variant.filename)) score -= 0.25;
  return score;
}

/** How a variant reads in the picker: "Full (fp16)", "Smaller (fp8)", "GGUF Q4_K_M". */
export function variantLabel(variant: Pick<ModelVariant, 'kind' | 'precision' | 'distilled'>): string {
  const base =
    variant.kind === 'gguf'
      ? `GGUF ${variant.precision ?? ''}`.trim()
      : variant.kind === 'fp8'
        ? 'Smaller (fp8)'
        : variant.precision
          ? `Full (${variant.precision})`
          : 'Full';
  return variant.distilled ? `${base} · distilled` : base;
}

/**
 * Where a variant's file goes. GGUF builds and Comfy-Org's split
 * `diffusion_models` files are diffusion models on their own; everything else
 * defers to the repository-level answer.
 */
export function variantSavePath(variant: ModelVariant, repositoryDefault: string): string {
  if (variant.kind === 'gguf') return 'diffusion_models';
  if (variant.path.startsWith('split_files/diffusion_models/')) return 'diffusion_models';
  if (variant.path.startsWith('split_files/checkpoints/')) return '';
  return repositoryDefault;
}

/** Our family names as a catalogue `base` the family module reads back. */
const FAMILY_BASE: Record<ModelFamily, string> = {
  [FAMILIES.sdxl]: 'SDXL',
  [FAMILIES.sdxlTurbo]: 'SDXL Turbo',
  [FAMILIES.pony]: 'Pony',
  [FAMILIES.illustrious]: 'Illustrious',
  [FAMILIES.sd15]: 'SD1.5',
  [FAMILIES.sd2]: 'SD2.x',
  [FAMILIES.sd3]: 'SD3',
  [FAMILIES.flux]: 'FLUX.1',
  [FAMILIES.hunyuanVideo]: 'Hunyuan Video',
  [FAMILIES.ltxVideo]: 'LTXV',
  [FAMILIES.svd]: 'SVD',
  [FAMILIES.wan]: 'Wan 2.2',
  [FAMILIES.wan22Ti2v5b]: 'Wan2.2 TI2V 5B',
  [FAMILIES.qwenImage]: 'Qwen-Image',
  [FAMILIES.zImage]: 'Z-Image',
  [FAMILIES.minimax]: 'MiniMax',
  [FAMILIES.hidream]: 'HiDream',
};

/**
 * The family a Hub model belongs to, as a catalogue base string, from the most
 * specific evidence first: the model it says it was built from, then its own
 * id, then its default file. Null when none of them names a family we know —
 * the entry then keeps the Hub's own base model as its label.
 */
export function huggingFaceFamilyBase(id: string, baseModels: readonly string[], filename: string | null): string | null {
  const evidence = [...baseModels, id, filename ?? ''];
  // Next generations under an old family's name: FLUX.2 and LTX-2.x are new
  // models with their own encoders, and the FLUX.1 / LTX-Video graphs would
  // load them and fail. Caught here so they are not read as the old family.
  if (evidence.some((text) => NEXT_GENERATION.test(text))) return null;
  for (const text of evidence) {
    if (!text) continue;
    const family = familyFromFilename(text.replace(/\//g, ' '));
    if (family) return FAMILY_BASE[family];
  }
  return null;
}

/** One file as the repository tree describes it. */
export interface TreeFile {
  path: string;
  size: number;
  sha256: string | null;
}

/**
 * The variants with their sizes and digests filled in, and the one that best
 * fits the machine marked recommended: the best build (in the variants' own
 * order) whose file fits in its graphics memory with a tenth to spare. When
 * the machine cannot load GGUF, GGUF builds are only recommended if nothing
 * else fits; when nothing fits at all, the smallest is. Without a memory
 * figure the first variant is the recommendation.
 */
export function sizedVariants(
  variants: readonly ModelVariant[],
  tree: readonly TreeFile[],
  memoryBytes: number | null,
  canLoadGguf: boolean,
): ModelVariant[] {
  const byPath = new Map(tree.map((file) => [file.path, file]));
  const sized = variants.map((variant) => {
    const file = byPath.get(variant.path);
    return { ...variant, sizeBytes: file?.size ?? null, sha256: file?.sha256 ?? null, recommended: false };
  });
  if (sized.length === 0) return sized;
  const fits = (variant: ModelVariant) =>
    memoryBytes === null || variant.sizeBytes == null || variant.sizeBytes <= memoryBytes * 0.9;
  const preferred = sized.filter((variant) => canLoadGguf || variant.kind !== 'gguf');
  const pick =
    preferred.find(fits) ??
    sized.find(fits) ??
    [...sized].sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity))[0]!;
  pick.recommended = true;
  return sized;
}
