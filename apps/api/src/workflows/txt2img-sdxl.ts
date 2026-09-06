/**
 * txt2img for the SDXL family.
 *
 * The reference template. It is the smallest graph that produces a saved image
 * from a prompt, and everything else (img2img, inpaint, upscale) is this shape
 * with nodes inserted between the loader and the sampler, so the manifest
 * conventions established here are the ones to copy.
 *
 * The graph lives in `graphs/txt2img-sdxl.api.json` rather than inline, because
 * it is the artifact a human edits and diffs — and because in that form it can
 * be pasted straight into ComfyUI's "Load (API format)" to check by eye. This
 * module's job is to attach types and the manifest to it.
 */

import type { ManifestInput, WorkflowManifest, WorkflowTemplate, ComfyApiGraph } from './types.js';
import {
  MAX_SEED,
  QUALITY_PRESETS,
  SDXL_RESOLUTIONS,
  SDXL_SAMPLERS,
  SDXL_SCHEDULERS,
} from './presets.js';
import rawGraph from './graphs/txt2img-sdxl.api.json' with { type: 'json' };

/**
 * JSON imports widen `["4", 1]` to `(string | number)[]`, which is not our
 * `NodeLink` tuple. The cast is safe because the unit tests validate the file's
 * structure against the API-format rules directly, which is a stronger check
 * than the structural one TypeScript could give us here.
 */
export const txt2imgSdxlGraph = rawGraph as unknown as ComfyApiGraph;

/**
 * Node ids match the ones ComfyUI's own default workflow uses (4 = checkpoint,
 * 6/7 = the two CLIPTextEncodes, 5 = latent, 3 = KSampler, 8 = decode, 9 =
 * save). They are arbitrary strings as far as ComfyUI is concerned, but keeping
 * the familiar numbering makes a graph dumped from a failed job instantly
 * readable by anyone who has seen the stock workflow. Ids are *not* required to
 * be dense or ordered.
 */
const INPUTS: readonly ManifestInput[] = [
  {
    path: '4.inputs.ckpt_name',
    source: 'checkpointFilename',
    label: 'Model',
    // Resolved from GenerationParams.modelId to the filename this backend knows
    // it by; the orchestrator has already ensured the chosen backend has it.
    constraint: { kind: 'model', modelType: 'checkpoint' },
    required: true,
  },
  {
    path: '6.inputs.text',
    source: 'prompt',
    label: 'Prompt',
    // SDXL's CLIP truncates around 77 tokens per chunk and ComfyUI chunks
    // beyond that, so there is no hard limit — this cap only exists to stop a
    // pasted novel from bloating every job row we store.
    constraint: { kind: 'string', maxLength: 4000 },
    required: true,
  },
  {
    path: '7.inputs.text',
    source: 'negativePrompt',
    label: 'Negative prompt',
    constraint: { kind: 'string', maxLength: 4000 },
    // Not required: an omitted negative prompt leaves the graph's empty string,
    // which is the correct "no negative conditioning" value for SDXL.
    required: false,
  },
  {
    path: '5.inputs.width',
    source: 'width',
    label: 'Width',
    // 64-step multiples: see the note on SDXL_RESOLUTIONS. 512 is below the
    // trained buckets but usable for drafts; 2048 is where a 24 GB card starts
    // to struggle without tiling.
    constraint: { kind: 'int', min: 512, max: 2048, step: 64 },
    required: true,
  },
  {
    path: '5.inputs.height',
    source: 'height',
    label: 'Height',
    constraint: { kind: 'int', min: 512, max: 2048, step: 64 },
    required: true,
  },
  {
    path: '5.inputs.batch_size',
    source: 'batchSize',
    label: 'Images',
    // One prompt, N images in a single sampler run. Capped at 8 because batch
    // is the fastest way to exhaust VRAM at SDXL resolutions, and because a
    // queue of separate jobs gives better progress feedback past that point.
    constraint: { kind: 'int', min: 1, max: 8, step: 1 },
    required: true,
  },
  {
    path: '3.inputs.seed',
    source: 'seed',
    label: 'Seed',
    constraint: { kind: 'int', min: 0, max: MAX_SEED, step: 1 },
    // Always written: when the user has not locked a seed the API generates one
    // and records it, so every image in the library can be reproduced.
    required: true,
  },
  {
    path: '3.inputs.steps',
    source: 'steps',
    label: 'Steps',
    // Below ~4 nothing converges on a non-turbo checkpoint; above ~80 the extra
    // time buys nothing visible on any sampler we expose.
    constraint: { kind: 'int', min: 1, max: 100, step: 1 },
    required: true,
  },
  {
    path: '3.inputs.cfg',
    source: 'guidance',
    label: 'Guidance',
    // ComfyUI accepts up to 100; anything past ~12 on SDXL is a burnt, saturated
    // image, so the drawer stops at 20 rather than offering rope.
    constraint: { kind: 'float', min: 1, max: 20 },
    required: true,
  },
  {
    path: '3.inputs.sampler_name',
    source: 'sampler',
    label: 'Sampler',
    constraint: { kind: 'enum', values: SDXL_SAMPLERS },
    required: true,
  },
  {
    path: '3.inputs.scheduler',
    source: 'scheduler',
    label: 'Scheduler',
    constraint: { kind: 'enum', values: SDXL_SCHEDULERS },
    required: true,
  },
  {
    path: '3.inputs.denoise',
    source: 'denoise',
    label: 'Denoise',
    // Fixed at 1.0 for txt2img — there is nothing to preserve when the latent
    // starts as noise. It is declared anyway so the img2img template, which is
    // this graph with a VAEEncode feeding the sampler, binds the same path to
    // the init reference's influence slider without inventing a new convention.
    constraint: { kind: 'float', min: 0, max: 1 },
    required: false,
  },
  {
    path: '9.inputs.filename_prefix',
    source: 'filenamePrefix',
    label: 'Filename prefix',
    // Written per job (e.g. "comfy-studio/<jobId>") so that reconciling a job
    // from /history after an API restart can match files back to their owner.
    constraint: { kind: 'string', maxLength: 200 },
    required: false,
  },
];

export const txt2imgSdxlManifest: WorkflowManifest = {
  id: 'txt2img-sdxl',
  version: 1,
  label: 'Text to image (SDXL)',
  capability: 'txt2img',
  // Every spelling of the family we accept, normalised by the registry before
  // comparison. "sdxl" is what our own model poller records; "SDXL 1.0" is what
  // Civitai calls it. Pony and Illustrious are SDXL derivatives with an
  // identical node set and the same resolution buckets, so they share this
  // template rather than getting near-duplicate ones of their own.
  baseModels: ['sdxl', 'SDXL 1.0', 'pony', 'illustrious'],
  requiredNodeClasses: [
    'CheckpointLoaderSimple',
    'CLIPTextEncode',
    'EmptyLatentImage',
    'KSampler',
    'VAEDecode',
    'SaveImage',
  ],
  outputNodeId: '9',
  inputs: INPUTS,
  resolutions: SDXL_RESOLUTIONS,
  quality: QUALITY_PRESETS,
  // MODEL is output 0 of CheckpointLoaderSimple and CLIP is output 1; the
  // compiler splices LoraLoaders after node 4 and repoints the samplers and
  // text encoders at the tail of the chain.
  lora: { anchorNodeId: '4', modelSlot: 0, clipSlot: 1, maxLoras: 8 },
};

export const txt2imgSdxlTemplate: WorkflowTemplate = {
  manifest: txt2imgSdxlManifest,
  graph: txt2imgSdxlGraph,
};
