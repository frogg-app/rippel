/**
 * txt2vid for the Hunyuan Video family.
 *
 * Until this file existed the family's verdict was "No workflow for this
 * yet", which was true and unhelpful: the box has a Hunyuan file on it and
 * nothing said what it would take to use it. This graph is ComfyUI's own
 * Hunyuan Video text-to-video example, node for node, so the answer is now a
 * list of files rather than a shrug.
 *
 * -------------------------------------------------------------------- shape
 *
 * Hunyuan is a 13B DiT with no negative conditioning — it is guidance
 * distilled — so the graph differs from the LTX ones in three ways:
 *
 *  - **Three separate loaders.** `UNETLoader` (4) for the diffusion model
 *    from `diffusion_models/`, `DualCLIPLoader` (12) for CLIP-L plus the
 *    LLaVA-Llama-3 text encoder from `text_encoders/`, and `VAELoader` (16)
 *    for the Hunyuan VAE from `vae/`. All three are companion requirements
 *    the user never picks, resolved against what the backend actually has.
 *  - **One prompt, guided by `FluxGuidance` (20).** There is no negative
 *    text encode; the Advanced drawer's guidance slider drives the
 *    FluxGuidance scale (reference value 6.0), and `ModelSamplingSD3` (21)
 *    applies the shift the model was trained with.
 *  - **`SamplerCustomAdvanced` (3)** with the noise, guider, sampler and
 *    sigmas as separate nodes — the modern ComfyUI sampling split. `steps`
 *    and `scheduler` bind to `BasicScheduler` (15), `seed` to `RandomNoise`
 *    (23), the integrator to `KSamplerSelect` (14).
 *
 * The decode is tiled (`VAEDecodeTiled`, 8) because a 73-frame 848x480 latent
 * decoded in one go exhausts a 16 GB card; the tile sizes are the example's.
 *
 * ---------------------------------------------------------------------------
 * Node classes and every input name below were verified against
 * `/object_info` on ComfyUI 0.34 at 192.168.1.10:8188 on 2026-09-07:
 * `DualCLIPLoader.type` lists `hunyuan_video`; `EmptyHunyuanLatentVideo`,
 * `FluxGuidance`, `ModelSamplingSD3`, `BasicGuider`, `BasicScheduler`,
 * `RandomNoise`, `SamplerCustomAdvanced` and `VAEDecodeTiled` are all
 * registered with the inputs used here.
 *
 * What the same box does *not* have: any text encoder (`text_encoders/` is
 * empty) and any VAE beyond `pixel_space`, so the verdict there is
 * "needs another model first" naming those files. Its one Hunyuan file,
 * `hunyuan_video_720p_fp8_e4m3fn.safetensors`, sits in `checkpoints/` —
 * the diffusion-model-only build, which ComfyUI-Manager filed as a checkpoint
 * — so for that file the verdict is "on disk, but the workflow cannot see
 * it" until it is moved to `diffusion_models/`. (It is also reported to be a
 * truncated download; see txt2vid-ltxv.ts. Re-downloading is the fix for
 * that, and the Models screen's Remove action is how to get Manager to.)
 */

import type {
  ComfyApiGraph,
  ManifestInput,
  ModelRequirement,
  WorkflowManifest,
  WorkflowTemplate,
} from './types.js';
import {
  HUNYUAN_FRAME_QUANTUM,
  HUNYUAN_MAX_FPS,
  HUNYUAN_MAX_FRAMES,
  HUNYUAN_MIN_FPS,
  HUNYUAN_MIN_FRAMES,
  HUNYUAN_QUALITY_PRESETS,
  HUNYUAN_RESOLUTIONS,
  HUNYUAN_SAMPLERS,
  HUNYUAN_SCHEDULERS,
  MAX_SEED,
} from './presets.js';
import rawGraph from './graphs/txt2vid-hunyuan.api.json' with { type: 'json' };

export const txt2vidHunyuanGraph = rawGraph as unknown as ComfyApiGraph;

/**
 * Spellings of the family, distinct after `normalizeBaseModel`: "hunyuan-video"
 * is what family.ts records, "hunyuanvideo" is a common catalogue spelling,
 * and both fold to the same key, so only one may be listed. "HunyuanVideo T2V"
 * folds to a different key and is how the Manager catalogue spells the base.
 */
export const HUNYUAN_BASE_MODELS = ['hunyuan-video', 'hunyuanvideo t2v'] as const;

export const HUNYUAN_CLIP_L_REQUIREMENT: ModelRequirement = {
  id: 'clip-l',
  path: '12.inputs.clip_name1',
  modelType: 'clip',
  label: 'CLIP-L text encoder',
  why: 'Hunyuan Video conditions on two encoders; CLIP-L is the first of the pair.',
  match: {
    filename: /clip[_-]?l/i,
    catalogueBase: ['clip', 'CLIP'],
    catalogueFilename: /clip_l/i,
  },
  preferred: ['clip_l.safetensors'],
};

export const HUNYUAN_LLAMA_REQUIREMENT: ModelRequirement = {
  id: 'llama',
  path: '12.inputs.clip_name2',
  modelType: 'clip',
  label: 'LLaVA-Llama-3 text encoder',
  why:
    'The second of the pair: the Llama-3 encoder that turns the prompt into the ' +
    'conditioning Hunyuan Video was trained on.',
  match: {
    filename: /llava|llama/i,
    catalogueBase: ['llama', 'Llama', 'llava'],
    catalogueFilename: /llava_llama3/i,
  },
  preferred: ['llava_llama3_fp8_scaled.safetensors', 'llava_llama3_fp16.safetensors'],
};

export const HUNYUAN_VAE_REQUIREMENT: ModelRequirement = {
  id: 'vae',
  path: '16.inputs.vae_name',
  modelType: 'vae',
  label: 'Hunyuan Video VAE',
  why: 'The diffusion model file holds no VAE; frames are decoded by this separate one.',
  match: {
    filename: /hunyuan/i,
    catalogueBase: ['hunyuan video', 'HunyuanVideo', 'hunyuanvideo t2v'],
    catalogueFilename: /hunyuan.*vae/i,
  },
  preferred: ['hunyuan_video_vae_bf16.safetensors'],
};

export const HUNYUAN_REQUIREMENTS: readonly ModelRequirement[] = [
  HUNYUAN_CLIP_L_REQUIREMENT,
  HUNYUAN_LLAMA_REQUIREMENT,
  HUNYUAN_VAE_REQUIREMENT,
];

const INPUTS: readonly ManifestInput[] = [
  {
    path: '4.inputs.unet_name',
    source: 'checkpointFilename',
    label: 'Model',
    constraint: { kind: 'model', modelType: 'checkpoint' },
    required: true,
  },
  {
    path: '6.inputs.text',
    source: 'prompt',
    label: 'Prompt',
    constraint: { kind: 'string', maxLength: 4000 },
    required: true,
  },
  // No negative prompt: the model is guidance-distilled and the graph has no
  // negative encode to bind one to. A request carrying one is simply not
  // written anywhere, which is the honest outcome.
  {
    path: '5.inputs.width',
    source: 'width',
    label: 'Width',
    constraint: { kind: 'int', min: 256, max: 1280, step: 16 },
    required: true,
  },
  {
    path: '5.inputs.height',
    source: 'height',
    label: 'Height',
    constraint: { kind: 'int', min: 256, max: 1280, step: 16 },
    required: true,
  },
  {
    path: '5.inputs.batch_size',
    source: 'batchSize',
    label: 'Clips',
    constraint: { kind: 'int', min: 1, max: 1, step: 1 },
    required: true,
  },
  {
    path: '5.inputs.length',
    source: 'frameCount',
    label: 'Frames',
    constraint: { kind: 'int', min: HUNYUAN_MIN_FRAMES, max: HUNYUAN_MAX_FRAMES, step: 1 },
    required: true,
  },
  {
    path: '9.inputs.fps',
    source: 'fps',
    label: 'Frame rate',
    constraint: { kind: 'int', min: HUNYUAN_MIN_FPS, max: HUNYUAN_MAX_FPS, step: 1 },
    required: true,
  },
  {
    path: '23.inputs.noise_seed',
    source: 'seed',
    label: 'Seed',
    constraint: { kind: 'int', min: 0, max: MAX_SEED, step: 1 },
    required: true,
  },
  {
    path: '15.inputs.steps',
    source: 'steps',
    label: 'Steps',
    constraint: { kind: 'int', min: 4, max: 50, step: 1 },
    required: true,
  },
  {
    path: '20.inputs.guidance',
    source: 'guidance',
    label: 'Guidance',
    constraint: { kind: 'float', min: 1, max: 10 },
    required: true,
  },
  {
    path: '14.inputs.sampler_name',
    source: 'sampler',
    label: 'Sampler',
    constraint: { kind: 'enum', values: HUNYUAN_SAMPLERS },
    required: true,
  },
  {
    path: '15.inputs.scheduler',
    source: 'scheduler',
    label: 'Scheduler',
    constraint: { kind: 'enum', values: HUNYUAN_SCHEDULERS },
    required: true,
  },
  {
    path: '9.inputs.filename_prefix',
    source: 'filenamePrefix',
    label: 'Filename prefix',
    constraint: { kind: 'string', maxLength: 200 },
    required: false,
  },
];

export const txt2vidHunyuanManifest: WorkflowManifest = {
  id: 'txt2vid-hunyuan',
  version: 1,
  label: 'Text to video (Hunyuan Video)',
  capability: 'txt2vid',
  baseModels: HUNYUAN_BASE_MODELS,
  requires: HUNYUAN_REQUIREMENTS,
  requiredNodeClasses: [
    'UNETLoader',
    'DualCLIPLoader',
    'VAELoader',
    'CLIPTextEncode',
    'FluxGuidance',
    'ModelSamplingSD3',
    'EmptyHunyuanLatentVideo',
    'BasicGuider',
    'KSamplerSelect',
    'BasicScheduler',
    'RandomNoise',
    'SamplerCustomAdvanced',
    'VAEDecodeTiled',
    'SaveWEBM',
  ],
  outputNodeId: '9',
  inputs: INPUTS,
  resolutions: HUNYUAN_RESOLUTIONS,
  quality: HUNYUAN_QUALITY_PRESETS,
  frameQuantum: HUNYUAN_FRAME_QUANTUM,
};

export const txt2vidHunyuanTemplate: WorkflowTemplate = {
  manifest: txt2vidHunyuanManifest,
  graph: txt2vidHunyuanGraph,
};
