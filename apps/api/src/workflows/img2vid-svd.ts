/**
 * img2vid for Stable Video Diffusion — the one video family that runs from a
 * single checkpoint file.
 *
 * `ImageOnlyCheckpointLoader` hands out MODEL, CLIP_VISION and VAE from the
 * one file, so there is no `requires` list: nothing to go missing. That is why
 * this template exists before WAN — it is the image-to-video path that works
 * on a backend holding only `checkpoints/SVD/svd.safetensors`.
 *
 * SVD takes no text. The prompt is recorded on the job but bound nowhere; the
 * image *is* the conditioning. `motion` is the trained `motion_bucket_id`
 * (1..1023, 127 is the model's own default). Frames are sampled at any count,
 * so there is no `frameQuantum`, but the base `svd` weights were trained on 14
 * and fall apart past ~25, which is the manifest's ceiling.
 */

import type { ComfyApiGraph, ManifestInput, WorkflowManifest, WorkflowTemplate } from './types.js';
import { MAX_SEED, SDXL_SAMPLERS, SDXL_SCHEDULERS, SVD_QUALITY_PRESETS, SVD_RESOLUTIONS } from './presets.js';
import rawGraph from './graphs/img2vid-svd.api.json' with { type: 'json' };

export const img2vidSvdGraph = rawGraph as unknown as ComfyApiGraph;

export const SVD_MIN_FRAMES = 2;
export const SVD_MAX_FRAMES = 25;
export const SVD_MIN_FPS = 3;
export const SVD_MAX_FPS = 30;

const INPUTS: readonly ManifestInput[] = [
  { path: '4.inputs.ckpt_name', source: 'checkpointFilename', label: 'Model', constraint: { kind: 'model', modelType: 'checkpoint' }, required: true },
  { path: '18.inputs.width', source: 'width', label: 'Width', constraint: { kind: 'int', min: 256, max: 1024, step: 8 }, required: true },
  { path: '18.inputs.height', source: 'height', label: 'Height', constraint: { kind: 'int', min: 256, max: 1024, step: 8 }, required: true },
  { path: '18.inputs.video_frames', source: 'frameCount', label: 'Frames', constraint: { kind: 'int', min: SVD_MIN_FRAMES, max: SVD_MAX_FRAMES, step: 1 }, required: true },
  { path: '18.inputs.motion_bucket_id', source: 'motion', label: 'Motion', constraint: { kind: 'int', min: 1, max: 1023, step: 1 }, required: false },
  { path: '18.inputs.fps', source: 'fps', label: 'Frame rate', constraint: { kind: 'int', min: SVD_MIN_FPS, max: SVD_MAX_FPS, step: 1 }, required: true },
  { path: '9.inputs.fps', source: 'fps', label: 'Frame rate', constraint: { kind: 'int', min: SVD_MIN_FPS, max: SVD_MAX_FPS, step: 1 }, required: true },
  { path: '3.inputs.seed', source: 'seed', label: 'Seed', constraint: { kind: 'int', min: 0, max: MAX_SEED, step: 1 }, required: true },
  { path: '3.inputs.steps', source: 'steps', label: 'Steps', constraint: { kind: 'int', min: 4, max: 60, step: 1 }, required: true },
  { path: '3.inputs.cfg', source: 'guidance', label: 'Guidance', constraint: { kind: 'float', min: 1, max: 10 }, required: true },
  { path: '3.inputs.sampler_name', source: 'sampler', label: 'Sampler', constraint: { kind: 'enum', values: SDXL_SAMPLERS }, required: true },
  { path: '3.inputs.scheduler', source: 'scheduler', label: 'Scheduler', constraint: { kind: 'enum', values: SDXL_SCHEDULERS }, required: true },
  { path: '9.inputs.filename_prefix', source: 'filenamePrefix', label: 'Filename prefix', constraint: { kind: 'string', maxLength: 200 }, required: false },
];

export const img2vidSvdManifest: WorkflowManifest = {
  id: 'img2vid-svd',
  version: 1,
  label: 'Image to video (Stable Video Diffusion)',
  capability: 'img2vid',
  baseModels: ['svd', 'stable-video-diffusion', 'svd-xt'],
  requiredNodeClasses: ['ImageOnlyCheckpointLoader', 'VideoLinearCFGGuidance', 'LoadImage', 'SVD_img2vid_Conditioning', 'KSampler', 'VAEDecode', 'SaveWEBM'],
  outputNodeId: '9',
  inputs: INPUTS,
  resolutions: SVD_RESOLUTIONS,
  quality: SVD_QUALITY_PRESETS,
};

export const img2vidSvdTemplate: WorkflowTemplate = { manifest: img2vidSvdManifest, graph: img2vidSvdGraph };
