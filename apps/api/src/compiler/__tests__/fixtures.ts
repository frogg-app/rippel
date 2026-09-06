/**
 * A stand-in for a real template + manifest. The genuine ones are authored in
 * `src/workflows/`; these exist so the compiler's tests do not depend on that
 * directory's content and keep passing when a real template is retuned.
 *
 * The graph is a minimal but honest SDXL txt2img: checkpoint -> two CLIP
 * encodes -> KSampler -> VAEDecode -> SaveImage, with the same link shape
 * ComfyUI's "Save (API format)" emits.
 */

import type { ComfyGraph, WorkflowManifest, WorkflowTemplate } from '../manifest.js';

export const SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'ddim'] as const;
export const SCHEDULERS = ['normal', 'karras', 'exponential'] as const;

export function makeGraph(): ComfyGraph {
  return {
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'placeholder.safetensors' },
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: { width: 512, height: 512, batch_size: 1 },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'placeholder positive', clip: ['4', 1] },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'placeholder negative', clip: ['4', 1] },
    },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['3', 0], vae: ['4', 2] },
    },
    '9': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'studio', images: ['8', 0] },
    },
  };
}

export const manifest: WorkflowManifest = {
  id: 'txt2img-sdxl',
  version: 1,
  label: 'Test template',
  capability: 'txt2img',
  baseModels: ['sdxl'],
  requiredNodeClasses: ['CheckpointLoaderSimple', 'KSampler', 'SaveImage'],
  outputNodeId: '9',
  resolutions: {
    '1:1': { width: 1024, height: 1024 },
    '3:2': { width: 1216, height: 832 },
    '2:3': { width: 832, height: 1216 },
    '16:9': { width: 1344, height: 768 },
    '9:16': { width: 768, height: 1344 },
  },
  quality: {
    fast: { steps: 12, cfg: 5, sampler: 'euler', scheduler: 'normal' },
    balanced: { steps: 28, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras' },
    high: { steps: 45, cfg: 8, sampler: 'dpmpp_2m', scheduler: 'karras' },
  },
  lora: { anchorNodeId: '4', modelSlot: 0, clipSlot: 1 },
  inputs: [
    { path: '4.inputs.ckpt_name', source: 'checkpointFilename', label: 'Model', constraint: { kind: 'model', modelType: 'checkpoint' }, required: true },
    { path: '6.inputs.text', source: 'prompt', label: 'Prompt', constraint: { kind: 'string', maxLength: 2000 }, required: true },
    { path: '7.inputs.text', source: 'negativePrompt', label: 'Negative prompt', constraint: { kind: 'string', maxLength: 2000 }, required: false },
    { path: '3.inputs.seed', source: 'seed', label: 'Seed', constraint: { kind: 'int', min: 0, max: Number.MAX_SAFE_INTEGER }, required: true },
    { path: '3.inputs.steps', source: 'steps', label: 'Steps', constraint: { kind: 'int', min: 1, max: 150 }, required: true },
    { path: '3.inputs.cfg', source: 'guidance', label: 'Guidance', constraint: { kind: 'float', min: 0, max: 30 }, required: true },
    { path: '3.inputs.sampler_name', source: 'sampler', label: 'Sampler', constraint: { kind: 'enum', values: SAMPLERS }, required: true },
    { path: '3.inputs.scheduler', source: 'scheduler', label: 'Scheduler', constraint: { kind: 'enum', values: SCHEDULERS }, required: true },
    { path: '3.inputs.denoise', source: 'denoise', label: 'Denoise', constraint: { kind: 'float', min: 0, max: 1 }, required: false },
    { path: '5.inputs.width', source: 'width', label: 'Width', constraint: { kind: 'int', min: 64, max: 2048, step: 8 }, required: true },
    { path: '5.inputs.height', source: 'height', label: 'Height', constraint: { kind: 'int', min: 64, max: 2048, step: 8 }, required: true },
    { path: '5.inputs.batch_size', source: 'batchSize', label: 'Images', constraint: { kind: 'int', min: 1, max: 8 }, required: true },
    { path: '9.inputs.filename_prefix', source: 'filenamePrefix', label: 'Filename prefix', constraint: { kind: 'string', maxLength: 200 }, required: false },
  ],
};

export function makeTemplate(): WorkflowTemplate {
  return { manifest, graph: makeGraph() };
}

export const CHECKPOINT_ID = '00000000-0000-4000-8000-000000000001';
export const LORA_A_ID = '00000000-0000-4000-8000-00000000000a';
export const LORA_B_ID = '00000000-0000-4000-8000-00000000000b';

export const modelFilenames = {
  [CHECKPOINT_ID]: 'sd_xl_base_1.0.safetensors',
  [LORA_A_ID]: 'detail-tweaker.safetensors',
  [LORA_B_ID]: 'film-grain.safetensors',
};
