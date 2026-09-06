/**
 * The Create form's state, and the one function that turns it into the
 * `GenerationParams` we POST.
 *
 * Kept pure and separate from the components because this is the expensive
 * thing to get wrong: a field the server does not expect is a 400 the user
 * cannot act on, and a field we silently drop is a control that appears to do
 * nothing. `toGenerationParams` is unit-tested against the shared type.
 */
import type {
  AdvancedParams,
  AspectRatio,
  GenerationParams,
  ImageSource,
  JobKind,
  LoraSelection,
  QualityPreset,
} from '@comfy/shared';

/**
 * The unions, once, as values.
 *
 * TypeScript erases a union at runtime, so a segmented control needs a list.
 * These are typed as `readonly QualityPreset[]` / `readonly AspectRatio[]`, so
 * adding a member to the shared union without adding it here is a *compile*
 * error in the exhaustiveness checks below rather than a control that quietly
 * lacks a button.
 */
export const QUALITY_PRESETS = ['fast', 'balanced', 'high'] as const satisfies readonly QualityPreset[];
export const ASPECT_RATIOS = ['1:1', '3:2', '2:3', '16:9', '9:16'] as const satisfies readonly AspectRatio[];

/** Enough of the union that a missing member fails to compile. */
const QUALITY_EXHAUSTIVE: Record<QualityPreset, (typeof QUALITY_PRESETS)[number]> = {
  fast: 'fast',
  balanced: 'balanced',
  high: 'high',
};
const ASPECT_EXHAUSTIVE: Record<AspectRatio, (typeof ASPECT_RATIOS)[number]> = {
  '1:1': '1:1',
  '3:2': '3:2',
  '2:3': '2:3',
  '16:9': '16:9',
  '9:16': '9:16',
};
void QUALITY_EXHAUSTIVE;
void ASPECT_EXHAUSTIVE;

/** Labels for the segmented control, so the union's spelling stays lowercase. */
export const QUALITY_LABELS: Record<QualityPreset, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  high: 'High',
};

/**
 * The curated sampler/scheduler lists, mirroring
 * `apps/api/src/workflows/presets.ts`. Like the capability fallback in
 * `api-jobs.ts` this is a copy of server knowledge; it belongs in a manifest
 * endpoint eventually, and the compiler validates against its own list either
 * way, so a stale entry here is a 400 rather than a bad graph.
 */
export const SAMPLERS = [
  'euler',
  'euler_ancestral',
  'heun',
  'dpm_2',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_3m_sde',
  'dpmpp_sde',
  'ddim',
  'uni_pc',
] as const;

export const SCHEDULERS = [
  'normal',
  'karras',
  'exponential',
  'sgm_uniform',
  'simple',
  'beta',
] as const;

/** What each quality preset resolves to, shown as the Advanced placeholders. */
export const PRESET_DEFAULTS: Record<
  QualityPreset,
  { steps: number; guidance: number; sampler: string; scheduler: string }
> = {
  fast: { steps: 16, guidance: 5.5, sampler: 'dpmpp_sde', scheduler: 'karras' },
  balanced: { steps: 28, guidance: 6.5, sampler: 'dpmpp_2m', scheduler: 'karras' },
  high: { steps: 45, guidance: 7.0, sampler: 'dpmpp_2m', scheduler: 'karras' },
};

export const MIN_BATCH = 1;
export const MAX_BATCH = 8;

/**
 * Seeds are unsigned 64-bit in ComfyUI and capped at 2^53-1 by the compiler,
 * but a seed a human is meant to read, retype and recognise wants to be short.
 * We roll in the 32-bit range, which every ComfyUI UI also uses.
 */
export const SEED_RANGE = 2 ** 32;

export function randomSeed(): number {
  return Math.floor(Math.random() * SEED_RANGE);
}

/** "874 203 551" — grouped, because a 9-digit run is unreadable. */
export function formatSeed(seed: number): string {
  return String(seed).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ---------------------------------------------------------------- state

export interface AdvancedState {
  /** `null` means "let the quality preset decide" — the field is omitted. */
  steps: number | null;
  guidance: number | null;
  sampler: string | null;
  scheduler: string | null;
  /** Always a concrete number: the seed shown is the seed that will be used. */
  seed: number;
  /** When false, Generate rolls a fresh seed first (see `prepareSubmit`). */
  seedLocked: boolean;
}

export interface CreateFormState {
  kind: JobKind;
  prompt: string;
  negativePrompt: string;
  /** The negative field is secondary; collapsed until asked for. */
  negativeOpen: boolean;
  modelId: string | null;
  quality: QualityPreset;
  aspect: AspectRatio;
  batchSize: number;
  loras: LoraSelection[];
  advanced: AdvancedState;
  /**
   * The starting image, when there is one. Its presence is what makes a job
   * img2img rather than txt2img — the user picks a picture, not a mode, which
   * is the whole point of the capability/manifest split.
   */
  initImage: InitImageState | null;
}

/**
 * A chosen starting image, in the two forms PLAN.md §6 insists are equal
 * citizens: something already in your library, or a file you just dropped.
 * `previewUrl` is whichever endpoint serves its bytes, so the panel can show a
 * thumbnail without caring which of the two it is.
 */
export interface InitImageState {
  source: ImageSource;
  previewUrl: string;
  /** 0..1. For an init image this is denoise: how far from the original to go. */
  influence: number;
}

export function initialFormState(): CreateFormState {
  return {
    kind: 'txt2img',
    prompt: '',
    negativePrompt: '',
    negativeOpen: false,
    modelId: null,
    quality: 'balanced',
    aspect: '1:1',
    batchSize: 1,
    loras: [],
    initImage: null,
    advanced: {
      steps: null,
      guidance: null,
      sampler: null,
      scheduler: null,
      seed: randomSeed(),
      seedLocked: false,
    },
  };
}

// ---------------------------------------------------------------- seed

/**
 * What Generate does to the seed before it submits.
 *
 * Locked: reuse the number on screen, so the next run is a controlled variation
 * of the last one. Unlocked: roll a new one *and show it*, because a seed the
 * user can see after the fact is the difference between "that was lucky" and
 * "I can get that back". Either way the params carry a concrete seed, so what
 * was displayed at submit time is what the sampler used.
 */
export function prepareSubmit(state: CreateFormState): CreateFormState {
  if (state.advanced.seedLocked) return state;
  return { ...state, advanced: { ...state.advanced, seed: randomSeed() } };
}

// ---------------------------------------------------------------- submittable

export interface Submittable {
  ok: boolean;
  /** Why not, phrased for a tooltip under a disabled button. */
  reason: string | null;
}

export function checkSubmittable(
  state: CreateFormState,
  context: { modelSupported: boolean; busy: boolean },
): Submittable {
  if (!state.prompt.trim()) return { ok: false, reason: 'Write a prompt first.' };
  if (!state.modelId) return { ok: false, reason: 'Pick a model.' };
  if (!context.modelSupported) {
    return { ok: false, reason: 'This model has no workflow template yet.' };
  }
  if (context.busy) return { ok: false, reason: 'A generation is already running.' };
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------- params

/**
 * Form state -> the request body.
 *
 * Every optional field is *omitted* rather than sent as null or "". The server
 * reads an absent `advanced.steps` as "use the preset"; an explicit null would
 * mean the same thing to a human and something else to a validator, and an
 * empty `negativePrompt` would be conditioned on as an empty string.
 */
export function toGenerationParams(state: CreateFormState): GenerationParams {
  if (!state.modelId) {
    throw new Error('toGenerationParams called with no model selected');
  }

  const params: GenerationParams = {
    // An init image *is* the difference between the two capabilities, so the
    // kind is derived from the form rather than tracked beside it — the two
    // could otherwise disagree, and the server would refuse the job.
    kind: state.initImage ? 'img2img' : state.kind,
    prompt: state.prompt.trim(),
    modelId: state.modelId,
    quality: state.quality,
    aspect: state.aspect,
    batchSize: state.batchSize,
  };

  const negative = state.negativePrompt.trim();
  if (negative) params.negativePrompt = negative;

  // A zero-weight LoRA is a LoRA that does nothing; sending it makes the
  // compiler build a loader node for no effect.
  const loras = state.loras.filter((lora) => lora.weight !== 0);
  if (loras.length > 0) params.loras = loras;

  if (state.initImage) {
    params.references = [
      {
        source: state.initImage.source,
        role: 'init',
        influence: state.initImage.influence,
      },
    ];
  }

  const advanced = toAdvancedParams(state.advanced);
  if (advanced) params.advanced = advanced;

  return params;
}

function toAdvancedParams(state: AdvancedState): AdvancedParams | undefined {
  const advanced: AdvancedParams = {};
  if (state.steps !== null) advanced.steps = state.steps;
  if (state.guidance !== null) advanced.guidance = state.guidance;
  if (state.sampler !== null) advanced.sampler = state.sampler;
  if (state.scheduler !== null) advanced.scheduler = state.scheduler;

  // The seed always goes: `prepareSubmit` has already decided which one, and
  // the user is looking at it.
  advanced.seed = state.seed;
  advanced.seedLocked = state.seedLocked;

  return advanced;
}

// ---------------------------------------------------------------- remix

/**
 * Refill the form from a job's params — the Remix action.
 *
 * The seed comes back *locked*: remixing an image you liked and getting a
 * different one because the seed re-rolled is the single most annoying possible
 * behaviour here. Unlock is one click away.
 */
/** Rebuild the panel's init-image state from a job's stored params. */
function initImageFrom(params: GenerationParams): InitImageState | null {
  const init = params.references?.find((ref) => ref.role === 'init');
  if (!init) return null;

  return {
    source: init.source,
    previewUrl:
      init.source.from === 'asset'
        ? `/api/assets/${init.source.assetId}/thumb`
        : `/api/uploads/${init.source.uploadId}/thumb`,
    influence: init.influence,
  };
}

export function fromGenerationParams(
  params: GenerationParams,
  previous: CreateFormState,
): CreateFormState {
  const advanced = params.advanced ?? {};
  return {
    ...previous,
    kind: params.kind,
    prompt: params.prompt,
    negativePrompt: params.negativePrompt ?? '',
    negativeOpen: Boolean(params.negativePrompt),
    modelId: params.modelId,
    quality: params.quality,
    aspect: params.aspect,
    batchSize: params.batchSize,
    loras: params.loras ? [...params.loras] : [],
    // Remixing an img2img job keeps its starting image. The preview URL is
    // rebuilt from the source rather than carried in the params, which only
    // ever hold ids.
    initImage: initImageFrom(params),
    advanced: {
      steps: advanced.steps ?? null,
      guidance: advanced.guidance ?? null,
      sampler: advanced.sampler ?? null,
      scheduler: advanced.scheduler ?? null,
      seed: advanced.seed ?? previous.advanced.seed,
      seedLocked: true,
    },
  };
}

// ---------------------------------------------------------------- estimate

/**
 * The line under Generate. Deliberately vague — it is a step count times a
 * guess at seconds-per-step, not a promise — so it is worded "about".
 */
export function estimateSeconds(state: CreateFormState): number {
  const steps = state.advanced.steps ?? PRESET_DEFAULTS[state.quality].steps;
  const SECONDS_PER_STEP = 0.28;
  return Math.max(2, Math.round(steps * SECONDS_PER_STEP * state.batchSize));
}
