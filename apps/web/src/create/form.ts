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
  VideoLimits,
} from '@comfy/shared';
import type { CreateMode } from './mode';

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

/**
 * What to call a sampler and a schedule in a list a human reads.
 *
 * `dpmpp_2m` is a filename, not a name. The value we send is unchanged — these
 * are only the words in the dropdown — but "DPM++ 2M · smooth, the safe choice"
 * lets someone who has never read a diffusion paper make a choice they can
 * reason about instead of picking at random. Anything the server offers that is
 * not listed here still renders, under its raw id: an unknown sampler must
 * appear, not vanish.
 */
export const SAMPLER_LABELS: Record<string, string> = {
  euler: 'Euler · plain and predictable',
  euler_ancestral: 'Euler ancestral · re-rolls detail each step',
  heun: 'Heun · slower, a little cleaner',
  dpm_2: 'DPM 2 · older, steady',
  dpmpp_2m: 'DPM++ 2M · smooth, the safe choice',
  dpmpp_2m_sde: 'DPM++ 2M SDE · grainier, more texture',
  dpmpp_3m_sde: 'DPM++ 3M SDE · more texture, slower',
  dpmpp_sde: 'DPM++ SDE · good when steps are few',
  ddim: 'DDIM · old faithful, very stable',
  uni_pc: 'UniPC · fast at low step counts',
};

export const SCHEDULER_LABELS: Record<string, string> = {
  normal: "Normal · the model's own default",
  karras: 'Karras · smoother, the usual choice',
  exponential: 'Exponential · softer fine detail',
  sgm_uniform: 'SGM uniform · for turbo/lightning models',
  simple: 'Simple · evenly spaced',
  beta: 'Beta · experimental',
};

/** A dropdown entry: the value we send, and the words beside it. */
export interface ChoiceOption {
  value: string;
  label: string;
}

export function samplerOptions(current: string): readonly ChoiceOption[] {
  return choiceOptions(SAMPLERS, SAMPLER_LABELS, current);
}

export function schedulerOptions(current: string): readonly ChoiceOption[] {
  return choiceOptions(SCHEDULERS, SCHEDULER_LABELS, current);
}

function choiceOptions(
  values: readonly string[],
  labels: Record<string, string>,
  current: string,
): readonly ChoiceOption[] {
  // The preset may resolve to something this list does not know — the server
  // owns the real list. Show it rather than silently selecting a neighbour.
  const all = values.includes(current) ? values : [current, ...values];
  return all.map((value) => ({ value, label: labels[value] ?? value }));
}

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
 * Video length and rate.
 *
 * These are the *widest* controls the screen will ever draw, not what any one
 * model accepts. They mirror the LTX-Video template's frame budget (9 to 161
 * frames) at watchable rates: 25 fps is what the model was trained at, so it is
 * the default and the longest clip at that rate is 6.4s.
 *
 * They used to be the only bounds, which is why every Stable Video Diffusion
 * clip longer than a second was rejected — SVD samples at most 25 frames, and
 * the default 4s at 25 fps asks for 100. The real per-model bounds come from
 * the server as `VideoLimits`; see `videoBoundsFor` below. This range is what
 * the controls fall back to before the server has answered, and a request built
 * on it is no worse than what the screen sent before.
 */
export const VIDEO_LENGTH_MIN = 1;
export const VIDEO_LENGTH_MAX = 6;
export const VIDEO_LENGTH_STEP = 0.5;
export const VIDEO_FPS_OPTIONS = [12, 16, 24, 25] as const;
export type VideoFps = (typeof VIDEO_FPS_OPTIONS)[number];

export interface VideoState {
  lengthSeconds: number;
  fps: number;
}

// ------------------------------------------------------- per-model video bounds

/** What the duration slider and the rate chips should offer for one model. */
export interface VideoBounds {
  lengthMin: number;
  lengthMax: number;
  lengthStep: number;
  fpsOptions: readonly number[];
}

export const DEFAULT_VIDEO_BOUNDS: VideoBounds = {
  lengthMin: VIDEO_LENGTH_MIN,
  lengthMax: VIDEO_LENGTH_MAX,
  lengthStep: VIDEO_LENGTH_STEP,
  fpsOptions: VIDEO_FPS_OPTIONS,
};

/**
 * Frames a length and rate will actually sample.
 *
 * This mirrors `videoFrameCount` in the API compiler, including the rounding
 * *up* onto the family's grid, because the number the compiler computes is the
 * number its constraint check rejects. Rounding to nearest here would let the
 * slider offer a duration that snaps one group past the ceiling.
 */
export function videoFrameCount(lengthSeconds: number, fps: number, quantum: number | null): number {
  const raw = Math.round(lengthSeconds * fps);
  if (!quantum || quantum <= 1) return raw;
  const groups = Math.ceil((raw - 1) / quantum);
  return Math.max(0, groups) * quantum + 1;
}

/** The rates this family allows, from the ones the screen has chips for. */
function fpsOptionsFor(limits: VideoLimits): readonly number[] {
  const allowed = VIDEO_FPS_OPTIONS.filter((fps) => fps >= limits.fps.min && fps <= limits.fps.max);
  // A family whose range excludes every chip we draw. Rather than render no
  // rate at all, offer the nearest end of its range as a single option — the
  // user still gets a working control and the request is still in range.
  if (allowed.length === 0) return [limits.fps.max];
  return allowed;
}

/**
 * Duration bounds for one model at the rate currently selected.
 *
 * The server sends a frame budget, not a duration, because seconds are a
 * property of this screen's two controls and frames are a property of the
 * model. Turning one into the other needs the rate, so it happens here, per
 * render, and changes when the user picks a different rate: SVD's 25 frames is
 * one second at 25 fps and two at 12.
 *
 * The `while` loops are not defensive padding. `frames.max / fps` is a duration
 * whose frame count can still snap *up* past the ceiling on a quantum family,
 * and the step grid means the nearest allowed duration is not simply the
 * quotient. Walking one step is cheaper than inverting the snap, and it cannot
 * be wrong.
 */
export function videoBoundsFor(limits: VideoLimits | null, fps: number): VideoBounds {
  if (!limits) return DEFAULT_VIDEO_BOUNDS;
  const step = VIDEO_LENGTH_STEP;
  const quantum = limits.frameQuantum;
  const frames = (length: number) => videoFrameCount(length, fps, quantum);
  const round = (value: number) => Math.round(value / step) * step;

  let lengthMin = Math.max(step, round(Math.ceil((limits.frames.min / fps) / step) * step));
  while (frames(lengthMin) < limits.frames.min) lengthMin = round(lengthMin + step);

  let lengthMax = round(Math.floor((limits.frames.max / fps) / step) * step);
  while (lengthMax > step && frames(lengthMax) > limits.frames.max) lengthMax = round(lengthMax - step);

  // A rate so high that no allowed duration exists on the step grid. Collapse
  // to a single point rather than hand back an inverted range.
  if (lengthMax < lengthMin) lengthMax = lengthMin;

  return { lengthMin, lengthMax, lengthStep: step, fpsOptions: fpsOptionsFor(limits) };
}

/**
 * The video settings this model would actually run, from the ones on the form.
 *
 * Applied during render and again at submit, rather than written back into form
 * state by an effect. An effect runs after the first paint, so the frame in
 * between shows — and could submit — a length the model rejects; and a write-back
 * would lose the user's chosen 6 seconds the moment they glanced at SVD, so
 * switching back to LTX would silently keep the clamped 1 second.
 */
export function clampVideo(video: VideoState, limits: VideoLimits | null): VideoState {
  if (!limits) return video;
  const options = fpsOptionsFor(limits);
  // Nearest allowed rate, not the first: a form sitting at 25 fps looking at a
  // family that caps at 24 wants 24, not 12.
  const fps = options.reduce((best, option) =>
    Math.abs(option - video.fps) < Math.abs(best - video.fps) ? option : best,
  );
  const bounds = videoBoundsFor(limits, fps);
  const lengthSeconds = Math.min(bounds.lengthMax, Math.max(bounds.lengthMin, video.lengthSeconds));
  return { lengthSeconds, fps };
}

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

/**
 * How many knobs the user has pinned away from the preset.
 *
 * The seed is excluded on purpose: it always has a value, so counting it would
 * make the drawer permanently claim an override and rob the count of the one
 * thing it is for — telling you, with the drawer shut, that the picture you get
 * is no longer the one the preset would have made.
 */
export function overrideCount(state: AdvancedState): number {
  return [state.steps, state.guidance, state.sampler, state.scheduler].filter(
    (entry) => entry !== null,
  ).length;
}

/**
 * Hand every knob back to the quality preset, keeping the seed.
 *
 * "Undo everything I fiddled with" is a thing people need after exploring, and
 * resetting four controls one at a time is not it. The seed stays because it is
 * not an override — it is the number on screen, and silently rerolling it here
 * would break the one promise the lock makes.
 */
export function resetAdvanced(state: AdvancedState): AdvancedState {
  return { ...state, steps: null, guidance: null, sampler: null, scheduler: null };
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
  /** Only read in video mode; kept across a toggle so nothing is lost. */
  video: VideoState;
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

/**
 * Mode + starting image -> the capability we are asking the server for.
 *
 * Four squares of one table, and the only place the mapping exists. The mode
 * toggle picks the row; whether the panel holds a starting image picks the
 * column. `upscale` is not reachable from this screen.
 */
export function deriveKind(mode: CreateMode, hasInitImage: boolean): JobKind {
  if (mode === 'video') return hasInitImage ? 'img2vid' : 'txt2vid';
  return hasInitImage ? 'img2img' : 'txt2img';
}

/** Which mode a job's capability belongs to — the inverse, for Remix. */
export function modeOfKind(kind: JobKind): CreateMode {
  return kind === 'txt2vid' || kind === 'img2vid' ? 'video' : 'image';
}

/**
 * The capability this form would submit right now.
 *
 * Everything that asks "can this model run what I am about to ask for?" — the
 * picker, the Generate button, `toGenerationParams` — must ask the same
 * question, or the screen offers a model the request then rejects.
 */
export function effectiveKind(state: CreateFormState): JobKind {
  return deriveKind(modeOfKind(state.kind), state.initImage !== null);
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
    video: { lengthSeconds: 4, fps: 25 },
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
    // The capability is derived, never stored beside the form: the mode says
    // image or video, an init image says txt2* or img2*, and the two together
    // are the only thing that decides. Tracking `kind` separately lets it
    // disagree with what the panel shows, and the server refuses the job.
    kind: effectiveKind(state),
    prompt: state.prompt.trim(),
    modelId: state.modelId,
    quality: state.quality,
    aspect: state.aspect,
    // A video job is one clip; the batch slider is not shown in video mode
    // and its value must not leak into the request.
    batchSize: modeOfKind(effectiveKind(state)) === 'video' ? 1 : state.batchSize,
  };

  if (modeOfKind(params.kind) === 'video') {
    params.video = {
      lengthSeconds: state.video.lengthSeconds,
      fps: state.video.fps,
      // No motion: there is no control for it, and each family's range is
      // different, so the template's own default is the only honest value.
    };
  }

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
    // The stored kind may be an img2* variant; the form holds the *base* kind
    // and re-derives the variant from the starting image, so a remixed
    // img2img job whose reference is dropped becomes txt2img by itself.
    kind: deriveKind(modeOfKind(params.kind), false),
    prompt: params.prompt,
    negativePrompt: params.negativePrompt ?? '',
    negativeOpen: Boolean(params.negativePrompt),
    modelId: params.modelId,
    quality: params.quality,
    aspect: params.aspect,
    batchSize: params.batchSize,
    video: params.video
      ? { lengthSeconds: params.video.lengthSeconds, fps: params.video.fps }
      : previous.video,
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
 * Seconds a run of this many steps is likely to take.
 *
 * A step count times a guess at seconds-per-step — honest enough to answer
 * "what does this cost me?" beside the Detail slider, which is the only
 * question a step count actually means to a non-technical user, and nowhere
 * near precise enough to state without the word "about".
 */
const SECONDS_PER_STEP = 0.28;

export function secondsForSteps(steps: number, batchSize: number): number {
  return Math.max(2, Math.round(steps * SECONDS_PER_STEP * batchSize));
}

/**
 * The line under Generate. Deliberately vague — see above — so it is worded
 * "about".
 */
export function estimateSeconds(state: CreateFormState): number {
  const steps = state.advanced.steps ?? PRESET_DEFAULTS[state.quality].steps;
  if (modeOfKind(state.kind) === 'video') {
    // A clip costs roughly one image per eight frames on the LTX template.
    const frames = state.video.lengthSeconds * state.video.fps;
    return secondsForSteps(steps, Math.max(1, Math.round(frames / 8)));
  }
  return secondsForSteps(steps, state.batchSize);
}

// ------------------------------------------------------- plain-English readings

/**
 * What a control is *doing*, in words, at the value it is currently set to.
 *
 * These exist because "cfg 7.0" and "28 steps" are not information to most
 * people: they are jargon that happens to be a number. A reading turns each
 * one into the two things a user actually wants — what this changes about the
 * picture, and what it costs — and is kept here, pure, so the wording is
 * unit-testable and the drawer stays a layout.
 */
export interface Reading {
  /** Two or three words for the value, e.g. "Fairly literal". */
  word: string;
  /** A sentence about what that means for the image. */
  hint: string;
}

/** Guidance: how literally the model is made to follow the prompt. */
export function guidanceReading(value: number): Reading {
  if (value <= 3) {
    return {
      word: 'Very loose',
      hint: 'The model mostly does its own thing. Dreamlike, often beautiful, frequently not what you asked for.',
    };
  }
  if (value <= 5.5) {
    return {
      word: 'Loose',
      hint: 'Your prompt is a strong suggestion. Softer, more natural images with room for invention.',
    };
  }
  if (value <= 8) {
    return {
      word: 'Balanced',
      hint: 'Follows your words, still fills in the details you did not mention. Where most images look best.',
    };
  }
  if (value <= 12) {
    return {
      word: 'Literal',
      hint: 'Sticks closely to the prompt. Good for a specific subject, at the cost of some subtlety.',
    };
  }
  return {
    word: 'Very literal',
    hint: 'Forces the prompt hard. Contrast and colour usually go harsh and over-baked past this point.',
  };
}

/** Steps: detail bought with time. */
export function stepsReading(steps: number, batchSize: number): Reading {
  const seconds = secondsForSteps(steps, batchSize);
  const time = `about ${seconds} second${seconds === 1 ? '' : 's'}`;

  if (steps <= 12) {
    return {
      word: 'Quick',
      hint: `Rough and fast — ${time}. Fine for trying out an idea before committing.`,
    };
  }
  if (steps <= 24) {
    return { word: 'Normal', hint: `A finished-looking image in ${time}.` };
  }
  if (steps <= 40) {
    return { word: 'Detailed', hint: `Cleaner edges and finer texture, ${time}.` };
  }
  return {
    word: 'Very detailed',
    hint: `${time[0]!.toUpperCase()}${time.slice(1)}, and past about 40 steps the extra detail is hard to see.`,
  };
}

/** LoRA weight: how much of the add-on style to mix in. */
export function loraReading(weight: number): Reading {
  if (weight <= 0) return { word: 'Off', hint: 'At zero this style is not applied at all.' };
  if (weight < 0.4) return { word: 'A hint', hint: 'Barely there — a flavour rather than a look.' };
  if (weight <= 0.9) return { word: 'Usual', hint: 'The strength most of these are trained for.' };
  if (weight <= 1.3) return { word: 'Strong', hint: 'The style leads the image.' };
  return { word: 'Overdone', hint: 'This far up, the style usually breaks anatomy and detail.' };
}
