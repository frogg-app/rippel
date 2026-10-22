/**
 * Which stable-diffusion.cpp recipe runs a model, and which files on the
 * backend fill the recipe's slots.
 *
 * sd-server does not take a graph. It takes a *recipe* — a named pipeline
 * such as `z-image-turbo` or `wan21-t2v` — and a file for each of the recipe's
 * slots: the diffusion weights, a text encoder, a VAE. Those slots are the
 * equivalent of the companion models a ComfyUI template names
 * (`workflows/requirements.ts`), and this module answers the same question
 * that file does for ComfyUI: given what this backend has on disk, can the
 * model run, and if not, what is missing?
 *
 * Two inputs decide everything: the model's *family* (`models.base_model`,
 * from `models/family.ts`) chooses the recipe, and the backend's file list
 * (`/sdcpp/v1/model-files`) fills the slots. A plan with no gaps is what the
 * dispatcher loads; a plan with gaps is what the readiness screen shows.
 *
 * Nothing here is clever about matching. A slot is filled by the first file in
 * its category whose name says what it is — "umt5" for Wan's text encoder,
 * "qwen3" for Z-Image's — and when a category holds exactly one file, that
 * file. A wrong companion loads and produces noise, so an unrecognised name is
 * a gap rather than a guess.
 */

import type { AspectRatio, JobKind } from '@comfy/shared';
import type { SdcppModelFile, SdcppRecipe } from '../lib/sdcpp.js';
import { discoverSdcppModels, type DiscoveredSdcppModel } from '../lib/sdcpp.js';

export type SdcppKind = 'img_gen' | 'vid_gen';

export interface SdcppGap {
  slot: string;
  /** The recipe's own label for the slot, e.g. "Qwen 3 Text Encoder". */
  label: string;
  /** Folder the file belongs in, e.g. `text_encoders`. */
  category: string;
  /** One sentence a person can act on. */
  hint: string;
}

export interface SdcppPlan {
  recipe: string;
  recipeName: string;
  kind: SdcppKind;
  /** Slot id -> sd-server file id. Complete only when `gaps` is empty. */
  models: Record<string, string>;
  gaps: SdcppGap[];
  /** The recipe's generation defaults, used when no ComfyUI preset exists. */
  defaults: Record<string, unknown>;
}

export type SdcppPlanResult =
  | { ok: true; plan: SdcppPlan }
  | { ok: false; reason: string; plan: SdcppPlan | null };

/** txt2img and img2img are one native mode; the video pair is the other. */
export function sdcppKindFor(capability: JobKind): SdcppKind | null {
  switch (capability) {
    case 'txt2img':
    case 'img2img':
      return 'img_gen';
    case 'txt2vid':
    case 'img2vid':
      return 'vid_gen';
    default:
      return null;
  }
}

/**
 * The recipe for a family, refined by the filename where one family spans
 * several recipes (dev vs schnell, 2.1 vs 2.2, turbo vs base).
 *
 * Returns null for a family upstream has no recipe for. That is the honest
 * answer and the caller says so; mapping LTX-Video 0.9 onto the LTX-2.3 recipe
 * would load and produce nothing useful.
 */
export function recipeIdFor(
  family: string | null,
  filename: string,
  capability: JobKind,
): string | null {
  const name = filename.toLowerCase().replace(/\\/g, '/');
  const video = capability === 'txt2vid' || capability === 'img2vid';
  const i2v = capability === 'img2vid';
  switch (family) {
    case 'sd1.5':
      return video ? null : 'sd1-checkpoint';
    case 'sd2.x':
      if (video) return null;
      if (/turbo/.test(name)) return 'sd-turbo';
      return /512/.test(name) ? 'sd2-512-checkpoint' : 'sd2-768-checkpoint';
    case 'sdxl':
    case 'pony':
    case 'illustrious':
      return video ? null : 'sdxl-checkpoint';
    case 'sdxl-turbo':
      return video ? null : 'sdxl-turbo';
    case 'sd3':
      if (video) return null;
      if (/3[._-]?5/.test(name)) return /large/.test(name) ? 'sd35-large' : 'sd35-medium';
      return 'sd3-medium';
    case 'flux.1':
      if (video) return null;
      if (/schnell/.test(name)) return 'flux1-schnell';
      if (/kontext/.test(name)) return 'flux1-kontext';
      if (/fill/.test(name)) return 'flux1-fill';
      return 'flux1-dev';
    case 'z-image':
      if (video) return null;
      return /turbo/.test(name) ? 'z-image-turbo' : 'z-image';
    case 'qwen-image':
      if (video) return null;
      if (/edit/.test(name)) return /2511/.test(name) ? 'qwen-image-edit-2511' : /2509/.test(name) ? 'qwen-image-edit-2509' : 'qwen-image-edit';
      if (/2[._-]?1/.test(name)) return /turbo/.test(name) ? 'qwen-image-21-turbo' : 'qwen-image-21';
      return 'qwen-image';
    case 'wan':
      if (!video) return null;
      if (/wan[-_. ]?2[._-]?2/.test(name)) return i2v ? 'wan22-i2v' : 'wan22-t2v';
      return i2v ? 'wan21-i2v' : 'wan21-t2v';
    case 'wan2.2-ti2v-5b':
      return video ? 'wan22-ti2v-5b' : null;
    case 'hunyuan-video':
      if (!video) return null;
      return /1[._-]?5/.test(name) ? (i2v ? 'hunyuan-video-15-i2v' : 'hunyuan-video-15-t2v') : null;
    default:
      return null;
  }
}

/**
 * How a companion slot is recognised by name, per recipe family.
 *
 * `recipes` narrows the rule to the recipes it is true for; `avoid` rejects a
 * name that matches the pattern for the wrong reason (`umt5` contains `t5`).
 * Order matters only within one slot: the first rule whose recipe matches
 * decides.
 */
interface CompanionRule {
  slot: string;
  recipes: RegExp;
  pattern: RegExp;
  avoid?: RegExp;
}

const COMPANIONS: readonly CompanionRule[] = [
  { slot: 't5xxl', recipes: /^wan/, pattern: /umt5/i },
  { slot: 't5xxl', recipes: /./, pattern: /t5[-_]?xxl|t5xxl/i, avoid: /umt5/i },
  { slot: 'clip_l', recipes: /./, pattern: /clip[-_]?l(?![a-z])/i },
  { slot: 'clip_g', recipes: /./, pattern: /clip[-_]?g(?![a-z])/i },
  { slot: 'llm', recipes: /^z-image/, pattern: /qwen[-_.]?3(?!\d)/i },
  { slot: 'llm', recipes: /^qwen-image/, pattern: /qwen[-_.]?2[-_.]?5/i },
  { slot: 'llm', recipes: /^flux2/, pattern: /mistral/i },
  { slot: 'llm', recipes: /^hunyuan/, pattern: /llava|llama/i },
  { slot: 'clip_vision', recipes: /./, pattern: /clip[-_]?vision/i },
  { slot: 'vae', recipes: /^wan22-ti2v/, pattern: /wan[-_. ]?2[._-]?2/i },
  { slot: 'vae', recipes: /^wan/, pattern: /wan/i, avoid: /wan[-_. ]?2[._-]?2.*vae|ti2v/i },
  { slot: 'vae', recipes: /^(flux1|z-image|chroma)/, pattern: /(^|\/)ae\.(safetensors|sft)$|flux.*vae/i },
  { slot: 'vae', recipes: /^flux2/, pattern: /flux[-_. ]?2.*vae|(^|\/)ae\.(safetensors|sft)$/i },
  { slot: 'vae', recipes: /^qwen-image/, pattern: /qwen.*vae/i },
  { slot: 'vae', recipes: /^sd3/, pattern: /sd3/i },
  { slot: 'vae', recipes: /^sdxl/, pattern: /sdxl|xl/i, avoid: /wan|flux|sd3|ae\./i },
  { slot: 'vae', recipes: /^(sd1|sd2|sd-turbo)/, pattern: /vae/i, avoid: /sdxl|xl|wan|flux|sd3|qwen|ae\./i },
  { slot: 'vae', recipes: /^hunyuan/, pattern: /hunyuan.*vae/i },
];

function fileNameOf(file: DiscoveredSdcppModel): string {
  return file.filename.toLowerCase();
}

/** The one file that fills a companion slot, or null. */
function companionFor(
  recipe: string,
  slot: SdcppRecipe['slots'][number],
  files: DiscoveredSdcppModel[],
): DiscoveredSdcppModel | null {
  const categories = (slot.categories ?? [slot.category]).map((c) => c.toLowerCase());
  const inCategory = files.filter((file) => categories.includes(file.category));
  if (inCategory.length === 0) return null;

  const rule = COMPANIONS.find((r) => r.slot === slot.id && r.recipes.test(recipe));
  if (rule) {
    const matches = inCategory.filter(
      (file) => rule.pattern.test(fileNameOf(file)) && !(rule.avoid && rule.avoid.test(fileNameOf(file))),
    );
    // Stable: shortest name first, which prefers `ae.safetensors` over
    // `ae-backup-copy.safetensors` and `umt5_xxl_fp8` over a longer variant.
    // No match is a gap, even with one file in the folder: when we know what
    // the slot wants, a lone UMT5 is not a Qwen3 encoder.
    return matches.sort((a, b) => a.filename.length - b.filename.length)[0] ?? null;
  }
  // A slot nobody wrote a rule for: the only file there is the best guess.
  return inCategory.length === 1 ? inCategory[0]! : null;
}

/**
 * Where the recipe wants the user's own model: `model` for a whole checkpoint
 * (`checkpoints/`), `diffusion_model` for bare weights (`diffusion_models/`).
 */
function mainSlotOf(recipe: SdcppRecipe): SdcppRecipe['slots'][number] | null {
  return recipe.slots.find((slot) => slot.id === 'diffusion_model') ?? recipe.slots.find((slot) => slot.id === 'model') ?? null;
}

export function normaliseFilename(filename: string): string {
  return filename.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
}

/**
 * Build the plan.
 *
 * `checkpointFilename` is the `models.filename` of the user's model; `files`
 * and `recipes` are what the backend reports right now.
 */
export function planFor(input: {
  family: string | null;
  checkpointFilename: string;
  modelLabel: string;
  capability: JobKind;
  files: SdcppModelFile[];
  recipes: SdcppRecipe[];
}): SdcppPlanResult {
  const kind = sdcppKindFor(input.capability);
  if (!kind) {
    return { ok: false, reason: `stable-diffusion.cpp does not do ${input.capability}.`, plan: null };
  }
  const recipeId = recipeIdFor(input.family, input.checkpointFilename, input.capability);
  if (!recipeId) {
    const what = input.family ? `${input.family} models` : 'a model of unknown family';
    const mode = kind === 'vid_gen' ? 'video' : 'image';
    return { ok: false, reason: `stable-diffusion.cpp has no ${mode} recipe for ${what}.`, plan: null };
  }
  const recipe = input.recipes.find((r) => r.id === recipeId);
  if (!recipe) {
    return { ok: false, reason: `This sd-server build has no "${recipeId}" recipe. Update stable-diffusion.cpp.`, plan: null };
  }

  const files = discoverSdcppModels(input.files);
  const plan: SdcppPlan = {
    recipe: recipe.id,
    recipeName: recipe.name,
    kind,
    models: {},
    gaps: [],
    defaults: recipe.defaults ?? {},
  };

  // The user's model first. It must sit in the folder the recipe's slot reads
  // from: sd-server classifies by folder, and a FLUX transformer filed under
  // checkpoints/ is refused by the load, so say "move it" rather than fail.
  const main = mainSlotOf(recipe);
  if (!main) {
    return { ok: false, reason: `Recipe "${recipe.id}" has no model slot.`, plan };
  }
  const wanted = normaliseFilename(input.checkpointFilename);
  const own = files.find((file) => file.type === 'checkpoint' && normaliseFilename(file.filename) === wanted);
  const mainCategories = (main.categories ?? [main.category]).map((c) => c.toLowerCase());
  if (!own) {
    plan.gaps.push({
      slot: main.id,
      label: main.label ?? 'Model',
      category: main.category,
      hint: `${input.modelLabel} is not in this machine's ${main.category}/ folder.`,
    });
  } else if (!mainCategories.includes(own.category)) {
    plan.gaps.push({
      slot: main.id,
      label: main.label ?? 'Model',
      category: main.category,
      hint: `Move ${own.filename} from ${own.category}/ to ${main.category}/ — the ${recipe.name} recipe reads it from there.`,
    });
  } else {
    plan.models[main.id] = own.fileId;
  }

  // Companions: every other required slot, then the "one of these" groups.
  for (const slot of recipe.slots) {
    if (slot.id === main.id || !slot.required) continue;
    const found = companionFor(recipe.id, slot, files);
    if (found) {
      plan.models[slot.id] = found.fileId;
    } else {
      plan.gaps.push({
        slot: slot.id,
        label: slot.label ?? slot.id,
        category: slot.category,
        hint: `${recipe.name} needs a ${slot.label ?? slot.id} in ${slot.category}/.`,
      });
    }
  }
  for (const group of recipe.required_any ?? []) {
    if (group.some((slotId) => plan.models[slotId])) continue;
    let filled = false;
    for (const slotId of group) {
      const slot = recipe.slots.find((s) => s.id === slotId);
      if (!slot) continue;
      const found = companionFor(recipe.id, slot, files);
      if (found) {
        plan.models[slotId] = found.fileId;
        filled = true;
        break;
      }
    }
    if (!filled) {
      const first = recipe.slots.find((s) => s.id === group[0]);
      plan.gaps.push({
        slot: group[0]!,
        label: first?.label ?? group[0]!,
        category: first?.category ?? 'vae',
        hint: `${recipe.name} needs a ${first?.label ?? group[0]} in ${first?.category ?? 'vae'}/.`,
      });
    }
  }

  if (plan.gaps.length > 0) {
    return { ok: false, reason: plan.gaps.map((gap) => gap.hint).join(' '), plan };
  }
  return { ok: true, plan };
}

/**
 * Pixel sizes when no ComfyUI template exists for the family.
 *
 * Keeps the recipe's default area (what the model was trained near) and
 * reshapes it to the aspect, snapped to 64 — a multiple every family here
 * accepts, and the one SD 1.x/2.x and SDXL need.
 */
export function fallbackDimensions(
  aspect: AspectRatio,
  defaults: Record<string, unknown>,
): { width: number; height: number } {
  const w = typeof defaults.width === 'number' && defaults.width > 0 ? defaults.width : 1024;
  const h = typeof defaults.height === 'number' && defaults.height > 0 ? defaults.height : 1024;
  const area = w * h;
  const ratios: Record<AspectRatio, number> = { '1:1': 1, '3:2': 3 / 2, '2:3': 2 / 3, '16:9': 16 / 9, '9:16': 9 / 16 };
  const ratio = ratios[aspect] ?? 1;
  const snap = (n: number) => Math.max(64, Math.round(n / 64) * 64);
  return { width: snap(Math.sqrt(area * ratio)), height: snap(Math.sqrt(area / ratio)) };
}

/**
 * ComfyUI sampler and scheduler names onto sd.cpp's. Unknown names are
 * dropped so the recipe default applies, which is always a working choice.
 */
const SAMPLERS: Record<string, string> = {
  euler: 'euler',
  euler_ancestral: 'euler_a',
  euler_a: 'euler_a',
  heun: 'heun',
  dpm_2: 'dpm2',
  dpmpp_2s_ancestral: 'dpm++2s_a',
  dpmpp_2m: 'dpm++2m',
  dpmpp_2m_sde: 'dpm++2m_sde',
  dpmpp_2m_sde_gpu: 'dpm++2m_sde',
  lcm: 'lcm',
  ddim: 'ddim_trailing',
  res_multistep: 'res_multistep',
  lms: 'lms',
  ipndm: 'ipndm',
  ipndm_v: 'ipndm_v',
  tcd: 'tcd',
  er_sde: 'er_sde',
};
const SCHEDULERS: Record<string, string> = {
  normal: 'normal',
  karras: 'karras',
  exponential: 'exponential',
  sgm_uniform: 'sgm_uniform',
  simple: 'simple',
  beta: 'beta',
  kl_optimal: 'kl_optimal',
  ddim_uniform: 'discrete',
};

export function sdcppSampler(name: string | undefined): string | undefined {
  return name ? SAMPLERS[name] ?? (Object.values(SAMPLERS).includes(name) ? name : undefined) : undefined;
}
export function sdcppScheduler(name: string | undefined): string | undefined {
  return name ? SCHEDULERS[name] ?? (Object.values(SCHEDULERS).includes(name) ? name : undefined) : undefined;
}
