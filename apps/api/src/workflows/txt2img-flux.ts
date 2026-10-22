/**
 * txt2img for FLUX.1 (dev, schnell and their fine-tunes).
 *
 * Until this file existed every FLUX model's verdict was "No workflow for
 * this yet", which hid one of the most-downloaded image families from Discover
 * once Hugging Face repositories became installable. The graph is ComfyUI's
 * own FLUX example, node for node:
 *
 *  - **Three loaders.** `UNETLoader` (4) for the diffusion model from
 *    `diffusion_models/` — swapped for `UnetLoaderGGUF` when the file is a GGUF
 *    build (see `withGgufLoaders`) — `DualCLIPLoader` (11, type `flux`) for
 *    CLIP-L plus T5-XXL from `text_encoders/`, and `VAELoader` (10) for the
 *    `ae` decoder from `vae/`. The three companions are requirements the user
 *    never picks, resolved against what the backend has.
 *  - **Guidance is `FluxGuidance` (26).** FLUX.1 is guidance-distilled: the
 *    sampler's own cfg stays at 1, the Advanced drawer's guidance slider drives
 *    the FluxGuidance scale (reference 3.5), and the negative conditioning is
 *    the positive zeroed out (33), so there is no negative prompt to bind.
 *  - **`EmptySD3LatentImage` (5)**: FLUX's 16-channel latent.
 *
 * Style add-ons splice in as `LoraLoaderModelOnly` after the diffusion-model
 * loader: FLUX LoRAs change the model, and the encoders are left alone.
 */

import type { ComfyApiGraph, ManifestInput, ModelRequirement, WorkflowManifest, WorkflowTemplate } from './types.js';
import { FLUX_QUALITY_PRESETS, FLUX_SAMPLERS, FLUX_SCHEDULERS, MAX_SEED, SDXL_RESOLUTIONS } from './presets.js';
import rawGraph from './graphs/txt2img-flux.api.json' with { type: 'json' };

export const txt2imgFluxGraph = rawGraph as unknown as ComfyApiGraph;

/** "flux.1" is what family.ts records; "flux1d"/"flux1s" are catalogue spellings of dev and schnell. */
export const FLUX_BASE_MODELS = ['flux.1', 'flux1d', 'flux1s'] as const;

export const FLUX_CLIP_L_REQUIREMENT: ModelRequirement = {
  id: 'clip-l',
  path: '11.inputs.clip_name1',
  modelType: 'clip',
  label: 'Prompt reader (CLIP-L text encoder)',
  why: 'FLUX reads the prompt with two encoders; CLIP-L is the smaller of the pair.',
  match: {
    filename: /clip[_-]?l/i,
    catalogueBase: ['clip', 'CLIP'],
    catalogueFilename: /clip_l/i,
  },
  preferred: ['clip_l.safetensors'],
};

export const FLUX_T5_REQUIREMENT: ModelRequirement = {
  id: 't5',
  path: '11.inputs.clip_name2',
  modelType: 'clip',
  label: 'Prompt reader (T5 text encoder)',
  why: 'The larger of the pair: T5-XXL, which is what lets FLUX follow long, detailed prompts.',
  match: {
    filename: /t5xxl/i,
    catalogueBase: ['t5', 'T5', 'clip'],
    catalogueFilename: /t5xxl/i,
  },
  preferred: ['t5xxl_fp8_e4m3fn_scaled.safetensors', 't5xxl_fp16.safetensors', 't5xxl_fp8_e4m3fn.safetensors'],
};

export const FLUX_VAE_REQUIREMENT: ModelRequirement = {
  id: 'vae',
  path: '10.inputs.vae_name',
  modelType: 'vae',
  label: 'FLUX image decoder (VAE)',
  why: 'The diffusion model file holds no decoder; images are decoded by FLUX’s own "ae".',
  match: {
    filename: /^(.*[\\/])?(ae|flux[_-]?ae|flux.*vae)\.(safetensors|sft)$/i,
    catalogueBase: ['flux.1', 'FLUX.1', 'flux'],
    catalogueFilename: /(^|[\\/])ae\.safetensors$/i,
  },
  preferred: ['ae.safetensors'],
};

export const FLUX_REQUIREMENTS: readonly ModelRequirement[] = [FLUX_CLIP_L_REQUIREMENT, FLUX_T5_REQUIREMENT, FLUX_VAE_REQUIREMENT];

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
  {
    path: '5.inputs.width',
    source: 'width',
    label: 'Width',
    constraint: { kind: 'int', min: 512, max: 2048, step: 16 },
    required: true,
  },
  {
    path: '5.inputs.height',
    source: 'height',
    label: 'Height',
    constraint: { kind: 'int', min: 512, max: 2048, step: 16 },
    required: true,
  },
  {
    path: '5.inputs.batch_size',
    source: 'batchSize',
    label: 'Images',
    // A 12B model: four at a megapixel is already most of a 24 GB card.
    constraint: { kind: 'int', min: 1, max: 4, step: 1 },
    required: true,
  },
  {
    path: '3.inputs.seed',
    source: 'seed',
    label: 'Seed',
    constraint: { kind: 'int', min: 0, max: MAX_SEED, step: 1 },
    required: true,
  },
  {
    path: '3.inputs.steps',
    source: 'steps',
    label: 'Steps',
    constraint: { kind: 'int', min: 1, max: 50, step: 1 },
    required: true,
  },
  {
    path: '26.inputs.guidance',
    source: 'guidance',
    label: 'Guidance',
    constraint: { kind: 'float', min: 1, max: 10 },
    required: true,
  },
  {
    path: '3.inputs.sampler_name',
    source: 'sampler',
    label: 'Sampler',
    constraint: { kind: 'enum', values: FLUX_SAMPLERS },
    required: true,
  },
  {
    path: '3.inputs.scheduler',
    source: 'scheduler',
    label: 'Scheduler',
    constraint: { kind: 'enum', values: FLUX_SCHEDULERS },
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

export const txt2imgFluxManifest: WorkflowManifest = {
  id: 'txt2img-flux',
  version: 1,
  label: 'Text to image (FLUX.1)',
  capability: 'txt2img',
  baseModels: FLUX_BASE_MODELS,
  requires: FLUX_REQUIREMENTS,
  requiredNodeClasses: [
    'UNETLoader',
    'DualCLIPLoader',
    'VAELoader',
    'CLIPTextEncode',
    'FluxGuidance',
    'ConditioningZeroOut',
    'EmptySD3LatentImage',
    'KSampler',
    'VAEDecode',
    'SaveImage',
  ],
  outputNodeId: '9',
  inputs: INPUTS,
  resolutions: SDXL_RESOLUTIONS,
  quality: FLUX_QUALITY_PRESETS,
  // DualCLIPLoader is a different node, so there is no CLIP slot on the
  // anchor to reroute; -1 matches no link.
  lora: { anchorNodeId: '4', modelSlot: 0, clipSlot: -1, nodeClass: 'LoraLoaderModelOnly', maxLoras: 4 },
};

export const txt2imgFluxTemplate: WorkflowTemplate = {
  manifest: txt2imgFluxManifest,
  graph: txt2imgFluxGraph,
};
