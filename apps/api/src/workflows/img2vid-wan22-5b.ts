/** Wan 2.2 TI2V 5B uses its own 48-channel VAE and latent node, not the
 * Wan 2.1/14B image-conditioning path. The official 0.11.55 library graph is
 * preserved with LoadImage explicitly enabled. Inputs were checked against a
 * local CPU ComfyUI 0.34.0 snapshot; GPU completion is still unverified.
 * Modest 32-aligned resolution buckets keep the initial memory budget small. */
import type { ComfyApiGraph, ManifestInput, WorkflowTemplate } from './types.js';
import rawGraph from './graphs/img2vid-wan22-5b.api.json' with { type: 'json' };
import { MAX_SEED, SDXL_SAMPLERS, SDXL_SCHEDULERS } from './presets.js';

const inputs: ManifestInput[] = [
  { path: '37.inputs.unet_name', source: 'checkpointFilename', label: 'Model', required: true, constraint: { kind: 'model', modelType: 'checkpoint' } },
  { path: '6.inputs.text', source: 'prompt', label: 'Prompt', required: true },
  { path: '7.inputs.text', source: 'negativePrompt', label: 'Negative prompt', required: false },
  ...(['width', 'height'] as const).map((source) => ({ path: `55.inputs.${source}`, source, label: source, required: true, constraint: { kind: 'int' as const, min: 256, max: 1280, step: 32 } })),
  { path: '55.inputs.length', source: 'frameCount', label: 'Frames', required: true, constraint: { kind: 'int', min: 5, max: 121, step: 1 } },
  { path: '55.inputs.batch_size', source: 'batchSize', label: 'Clips', required: true, constraint: { kind: 'int', min: 1, max: 1, step: 1 } },
  { path: '57.inputs.fps', source: 'fps', label: 'Frame rate', required: true, constraint: { kind: 'int', min: 1, max: 30, step: 1 } },
  { path: '3.inputs.seed', source: 'seed', label: 'Seed', required: true, constraint: { kind: 'int', min: 0, max: MAX_SEED, step: 1 } },
  { path: '3.inputs.steps', source: 'steps', label: 'Steps', required: true, constraint: { kind: 'int', min: 4, max: 60, step: 1 } },
  { path: '3.inputs.cfg', source: 'guidance', label: 'Guidance', required: true, constraint: { kind: 'float', min: 1, max: 10 } },
  { path: '3.inputs.sampler_name', source: 'sampler', label: 'Sampler', required: true, constraint: { kind: 'enum', values: SDXL_SAMPLERS } },
  { path: '3.inputs.scheduler', source: 'scheduler', label: 'Scheduler', required: true, constraint: { kind: 'enum', values: SDXL_SCHEDULERS } },
  { path: '58.inputs.filename_prefix', source: 'filenamePrefix', label: 'Filename', required: false },
];
export const img2vidWan22Template: WorkflowTemplate = {
  graph: rawGraph as unknown as ComfyApiGraph,
  manifest: {
    id: 'img2vid-wan22-5b', version: 1, label: 'Image to video (Wan 2.2 TI2V 5B)',
    capability: 'img2vid', baseModels: ['wan2.2-ti2v-5b'], frameQuantum: 4,
    initImageNodeId: '56', outputNodeId: '58', inputs,
    requiredNodeClasses: [...new Set(Object.values(rawGraph).map((node) => node.class_type))],
    requires: [
      { id: 'text-encoder', path: '38.inputs.clip_name', modelType: 'clip', label: 'Prompt reader (UMT5-XXL text encoder)', why: 'Wan uses UMT5 conditioning, not the T5 encoder used by LTX.',
        match: { filename: /(?:^|[\\/])umt5_xxl_(?:fp16|fp8_e4m3fn(?:_scaled)?)\.safetensors$/i }, preferred: ['umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'umt5_xxl_fp16.safetensors'] },
      { id: 'vae', path: '39.inputs.vae_name', modelType: 'vae', label: 'Wan 2.2 image decoder (VAE)', why: 'TI2V 5B requires the Wan 2.2 VAE; the Wan 2.1 VAE is incompatible.',
        match: { filename: /(?:^|[\\/])wan2\.2_vae\.safetensors$/i }, preferred: ['wan2.2_vae.safetensors'] },
    ],
    resolutions: {
      '1:1': { width: 512, height: 512 }, '3:2': { width: 576, height: 384 },
      '2:3': { width: 384, height: 576 }, '16:9': { width: 512, height: 288 }, '9:16': { width: 288, height: 512 },
    },
    quality: {
      fast: { steps: 8, cfg: 5, sampler: 'uni_pc', scheduler: 'simple' },
      balanced: { steps: 12, cfg: 5, sampler: 'uni_pc', scheduler: 'simple' },
      high: { steps: 20, cfg: 5, sampler: 'uni_pc', scheduler: 'simple' },
    },
  },
};
