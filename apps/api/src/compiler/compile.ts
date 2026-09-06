/**
 * The compiler: GenerationParams + template + manifest -> a concrete ComfyUI
 * API-format graph.
 *
 * It returns the resolved values alongside the graph because the job row has to
 * record exactly what ran. "Random seed, balanced preset" is not enough to
 * re-run a generation a month later; "seed 8123…, 28 steps, dpmpp_2m, karras,
 * 1024x1024" is. Everything the compiler decided on the user's behalf comes back
 * out so it can be persisted.
 */

import type {
  AspectRatio,
  GenerationParams,
  QualityPreset,
  Uuid,
} from '@comfy/shared';

import { TemplateError, ValidationError } from './errors.js';
import { cloneGraph, setPathInPlace } from './json-path.js';
import { applyLoraChain, type ResolvedLora } from './lora.js';
import type {
  ComfyGraph,
  ManifestBinding,
  ManifestInput,
  PresetDefaults,
  WorkflowManifest,
  WorkflowTemplate,
} from './manifest.js';
import { resolveSeed } from './seed.js';
import { checkValue, MAX_PROMPT_LENGTH } from './validate.js';

export interface CompileInput {
  params: GenerationParams;
  template: WorkflowTemplate;
  /**
   * modelId -> the filename ComfyUI knows the file by, for the checkpoint and
   * for every selected LoRA. The compiler is deliberately storage-agnostic: the
   * caller (which already had to check the chosen backend actually has these
   * files on disk) does the lookup, and we only fail if a needed id is absent.
   */
  modelFilenames: Readonly<Record<Uuid, string>>;
  /**
   * The job this graph is for. It becomes the SaveImage filename prefix, which
   * is how a /history reconciliation pass after an API restart matches files on
   * the backend's disk back to the job that asked for them.
   */
  jobId: Uuid;
}

/** Values derived once per compile and reused by every input that wants them. */
interface ResolveContext {
  seed: number;
  width: number;
  height: number;
  checkpoint: string;
  filenamePrefix: string;
}

export interface Substitution {
  path: string;
  binding: ManifestBinding;
  value: string | number | boolean;
}

export interface ResolvedValues {
  templateId: string;
  /** Always concrete, even when the user asked for a random seed. */
  seed: number;
  checkpoint: string;
  loras: ResolvedLora[];
  width: number;
  height: number;
  /** Every logical value that reached the graph, keyed by binding. */
  values: Partial<Record<ManifestBinding, string | number | boolean>>;
  /** Node ids created for the LoRA chain, in chain order. */
  loraNodeIds: string[];
}

export interface CompileResult {
  graph: ComfyGraph;
  resolved: ResolvedValues;
  /** Path-level detail; handy in logs when a graph misbehaves. */
  substitutions: Substitution[];
}

// ---------------------------------------------------------------- dimensions

/**
 * Aspect ratios become pixels here rather than in the UI, because the right
 * pixel sizes are a property of the model family: SDXL was trained on a fixed
 * set of ~1MP buckets and straying off them costs quality, so the manifest
 * ships an explicit table rather than us deriving sizes arithmetically from a
 * long edge. Looking the value up also means an unsupported ratio is caught
 * here instead of producing a plausible-looking size the model handles badly.
 */
export function dimensionsFor(
  aspect: AspectRatio,
  manifest: WorkflowManifest,
): { width: number; height: number } {
  const resolution = manifest.resolutions[aspect];
  if (!resolution) {
    throw new ValidationError('aspect', `Model "${manifest.id}" does not support aspect ratio "${aspect}"`);
  }
  return { width: resolution.width, height: resolution.height };
}

// ---------------------------------------------------------------- resolution

function qualityDefaults(template: WorkflowTemplate, quality: QualityPreset): PresetDefaults {
  const preset = template.manifest.quality[quality];
  if (!preset) {
    throw new TemplateError(`Template "${template.manifest.id}" has no "${quality}" quality preset`);
  }
  return preset;
}

function initDenoise(params: GenerationParams): number | undefined {
  // `influence` on an `init` reference *is* denoise strength — see the comment
  // on ImageReference in @comfy/shared. Conditioning roles are not denoise and
  // must not be mistaken for it.
  const init = params.references?.find((r) => r.role === 'init');
  return init?.influence;
}

// ---------------------------------------------------------------- video

/**
 * Frames to sample, from the length and rate the user actually chose.
 *
 * `GenerationParams.video` has no frame count and must not gain one: frames are
 * `lengthSeconds * fps`, and carrying the product alongside its factors is an
 * invitation for the three to disagree after a re-run edits one of them.
 *
 * The product is then snapped up onto the family's `frameQuantum * n + 1` grid
 * (see the note on `frameQuantum` in workflows/types.ts). Rounding *up* rather
 * than to nearest is deliberate — a clip that is a fraction of a frame longer
 * than asked for is unremarkable, one that is shorter looks truncated — and the
 * snapped value is what the manifest constraint is then checked against, so a
 * request just under the template's ceiling cannot be pushed over it silently.
 *
 * Returns `undefined` when the request carries no video block at all; the
 * template's `required: true` on the input turns that into the readable
 * "Frames is required by this model but was not supplied".
 */
export function videoFrameCount(
  params: GenerationParams,
  manifest: WorkflowManifest,
): number | undefined {
  const video = params.video;
  if (!video) return undefined;
  const raw = video.lengthSeconds * video.fps;
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new ValidationError('frameCount', 'Video length and frame rate must both be positive');
  }
  const quantum = manifest.frameQuantum;
  if (quantum === undefined || quantum <= 1) return Math.round(raw);
  // ceil onto {1, q+1, 2q+1, ...}; a request for exactly q*n+1 is left alone.
  const groups = Math.ceil((Math.round(raw) - 1) / quantum);
  return Math.max(0, groups) * quantum + 1;
}

/**
 * The single place a binding turns into a value. Returns `undefined` when the
 * request simply doesn't carry one — the caller decides whether that is a
 * default, a no-op, or an error.
 */
function resolveBinding(
  binding: ManifestBinding,
  input: CompileInput,
  ctx: ResolveContext,
): string | number | boolean | undefined {
  const { params } = input;
  const advanced = params.advanced ?? {};
  const preset = qualityDefaults(input.template, params.quality);

  switch (binding) {
    case 'prompt':
      return params.prompt;
    case 'negativePrompt':
      return params.negativePrompt ?? '';
    case 'checkpointFilename':
      return ctx.checkpoint;
    case 'seed':
      return ctx.seed;
    case 'steps':
      return advanced.steps ?? preset.steps;
    case 'guidance':
      return advanced.guidance ?? preset.cfg;
    case 'sampler':
      return advanced.sampler ?? preset.sampler;
    case 'scheduler':
      return advanced.scheduler ?? preset.scheduler;
    case 'width':
      return ctx.width;
    case 'height':
      return ctx.height;
    case 'batchSize':
      return params.batchSize;
    case 'denoise':
      return initDenoise(params);
    case 'filenamePrefix':
      // Namespaced per job so reconciling from /history after a restart can
      // match a file on disk back to the job (and therefore the user) that
      // asked for it. The job id is supplied by the caller via ctx.
      return ctx.filenamePrefix;

    // ------------------------------------------------------------- video
    // All four read `params.video`, which is absent for every image
    // capability. Returning undefined there is correct rather than defensive:
    // an image template binds none of these, so nothing asks.
    case 'fps':
      return params.video?.fps;
    case 'frameCount':
      return videoFrameCount(params, input.template.manifest);
    case 'motion':
      return params.video?.motion;
    case 'cameraPreset':
      return params.video?.cameraPreset;
  }
}

function lookupFilename(
  modelFilenames: Readonly<Record<Uuid, string>>,
  modelId: Uuid,
  field: string,
): string {
  const filename = modelFilenames[modelId];
  if (filename === undefined || filename.length === 0) {
    throw new ValidationError(field, `Model ${modelId} is not available on the selected backend`);
  }
  return filename;
}

// ---------------------------------------------------------------- compile

export function compile(input: CompileInput): CompileResult {
  const { params, template, modelFilenames } = input;
  const { manifest } = template;

  if (params.kind !== manifest.capability) {
    throw new TemplateError(
      `Template "${manifest.id}" is for ${manifest.capability}, but the job is ${params.kind}`,
    );
  }
  if (!Number.isInteger(params.batchSize) || params.batchSize < 1) {
    throw new ValidationError('batchSize', 'batchSize must be a positive whole number');
  }

  const checkpoint = lookupFilename(modelFilenames, params.modelId, 'modelId');
  const seed = resolveSeed(params.advanced?.seed);
  const { width, height } = dimensionsFor(params.aspect, manifest);
  const ctx: ResolveContext = {
    seed,
    width,
    height,
    checkpoint,
    filenamePrefix: `comfy-studio/${params.kind}/${input.jobId}`,
  };

  // Pass 1: resolve and validate everything. Nothing touches the graph until
  // every value is known-good, so a rejected request cannot leave a partially
  // substituted graph anywhere.
  const substitutions: Substitution[] = [];
  const values: Partial<Record<ManifestBinding, string | number | boolean>> = {};

  for (const manifestInput of manifest.inputs) {
    const value = resolveForInput(manifestInput, input, ctx);
    if (value === undefined) continue; // optional and unsupplied: keep the template's own value
    substitutions.push({ path: manifestInput.path, binding: manifestInput.source, value });
    values[manifestInput.source] = value;
  }

  const loras = resolveLoras(params, modelFilenames);

  // Pass 2: apply. `cloneGraph` up front is what guarantees the template — a
  // module-level constant shared by every job — is never mutated.
  let graph = cloneGraph(template.graph);
  for (const s of substitutions) setPathInPlace(graph, s.path, s.value);

  let loraNodeIds: string[] = [];
  if (loras.length > 0) {
    if (!manifest.lora) {
      throw new ValidationError('loras', `Template "${manifest.id}" does not support LoRAs`);
    }
    const chained = applyLoraChain(graph, manifest.lora, loras);
    graph = chained.graph;
    loraNodeIds = chained.nodeIds;
  }

  return {
    graph,
    substitutions,
    resolved: { templateId: manifest.id, seed, checkpoint, loras, width, height, values, loraNodeIds },
  };
}

function resolveForInput(
  manifestInput: ManifestInput,
  input: CompileInput,
  ctx: ResolveContext,
): string | number | boolean | undefined {
  const raw = resolveBinding(manifestInput.source, input, ctx);
  // Blank is "not supplied" for a required input — a whitespace-only prompt is
  // the case that matters, since ComfyUI would accept it and burn GPU time on
  // pure noise — but it is a legitimate value for an optional one, where it
  // means "leave the graph's own empty literal alone".
  const missing = raw === undefined || (typeof raw === 'string' && raw.trim() === '');

  if (missing) {
    if (!manifestInput.required) return undefined;
    throw new ValidationError(
      manifestInput.source,
      `${manifestInput.label} is required by this model but was not supplied`,
    );
  }
  // No constraint means a free-form value the manifest cannot bound; the global
  // string cap in validate.ts still applies to text.
  if (!manifestInput.constraint) {
    return checkValue(
      manifestInput.source,
      raw,
      { kind: 'string', maxLength: MAX_PROMPT_LENGTH },
      manifestInput.label,
    );
  }
  return checkValue(manifestInput.source, raw, manifestInput.constraint, manifestInput.label);
}

function resolveLoras(
  params: GenerationParams,
  modelFilenames: Readonly<Record<Uuid, string>>,
): ResolvedLora[] {
  return (params.loras ?? []).map((selection, i) => ({
    filename: lookupFilename(modelFilenames, selection.modelId, `loras[${i}]`),
    weight: selection.weight,
  }));
}
