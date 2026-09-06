/**
 * img2vid for LTX-Video, loading the model from `diffusion_models/`.
 *
 * img2vid-ltxv with the loader swapped, exactly as txt2vid-ltxv-dm is to
 * txt2vid-ltxv — see that file's header for why the pair exists. The one
 * extra wire: `LTXVImgToVideo` (18) encodes the first frame through the VAE,
 * so it takes its VAE from node 16 too, not only the decode.
 *
 * The first-frame `LoadImage` keeps node id 10, which is what the dispatcher
 * rewrites after transferring the picture; see IMG2VID_FIRST_FRAME_NODE_ID.
 */

import type { ComfyApiGraph, WorkflowManifest, WorkflowTemplate } from './types.js';
import { LTXV_FRAME_QUANTUM, LTXV_QUALITY_PRESETS, LTXV_RESOLUTIONS } from './presets.js';
import { IMG2VID_LTXV_INPUTS } from './img2vid-ltxv.js';
import { LTXV_BASE_MODELS } from './txt2vid-ltxv.js';
import { LTXV_DM_REQUIREMENTS, repointToUnet } from './txt2vid-ltxv-dm.js';
import rawGraph from './graphs/img2vid-ltxv-dm.api.json' with { type: 'json' };

export const img2vidLtxvDmGraph = rawGraph as unknown as ComfyApiGraph;

export const img2vidLtxvDmManifest: WorkflowManifest = {
  id: 'img2vid-ltxv-dm',
  version: 1,
  label: 'Image to video (LTX-Video, diffusion_models)',
  capability: 'img2vid',
  baseModels: LTXV_BASE_MODELS,
  requires: LTXV_DM_REQUIREMENTS,
  requiredNodeClasses: [
    'UNETLoader',
    'VAELoader',
    'CLIPLoader',
    'CLIPTextEncode',
    'LoadImage',
    'LTXVPreprocess',
    'LTXVImgToVideo',
    'LTXVConditioning',
    'KSamplerSelect',
    'LTXVScheduler',
    'SamplerCustom',
    'VAEDecode',
    'SaveWEBM',
  ],
  outputNodeId: '9',
  inputs: repointToUnet(IMG2VID_LTXV_INPUTS),
  resolutions: LTXV_RESOLUTIONS,
  quality: LTXV_QUALITY_PRESETS,
  frameQuantum: LTXV_FRAME_QUANTUM,
};

export const img2vidLtxvDmTemplate: WorkflowTemplate = {
  manifest: img2vidLtxvDmManifest,
  graph: img2vidLtxvDmGraph,
};
