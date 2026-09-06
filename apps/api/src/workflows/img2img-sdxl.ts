/**
 * img2img for the SDXL family.
 *
 * This is `txt2img-sdxl` with one substitution: the EmptyLatentImage (node 5)
 * is gone, and a LoadImage -> VAEEncode pair (nodes 10 and 11) feeds the
 * sampler's `latent_image` instead. Everything else — the checkpoint loader,
 * the two text encoders, the sampler, the decode and the save — is byte-for-byte
 * the same graph, and the node ids it shares with txt2img keep their meaning so
 * a dumped graph from either template reads the same way.
 *
 * Two consequences of that substitution are worth stating outright, because
 * both are places where the obvious assumption is wrong:
 *
 *  - **There is no width/height/batch_size binding.** Those were inputs of the
 *    empty latent. Here the output size *is* the init image's size, decided by
 *    the pixels the user handed us, and the batch is one image per run. The
 *    manifest therefore binds neither; `resolutions` still exists on it because
 *    the compiler resolves the aspect ratio unconditionally, but nothing in
 *    this graph consumes the result.
 *  - **`denoise` stops being a constant.** In txt2img it is pinned at 1.0
 *    because the latent starts as noise. Here it is the whole point of the
 *    template, and it is bound to the sampler exactly as txt2img's manifest
 *    comment promised it would be — see the note on the denoise input below.
 */

import type { ManifestInput, WorkflowManifest, WorkflowTemplate, ComfyApiGraph } from './types.js';
import {
  MAX_SEED,
  QUALITY_PRESETS,
  SDXL_RESOLUTIONS,
  SDXL_SAMPLERS,
  SDXL_SCHEDULERS,
} from './presets.js';
import rawGraph from './graphs/img2img-sdxl.api.json' with { type: 'json' };

/** See the note on the identical cast in txt2img-sdxl.ts. */
export const img2imgSdxlGraph = rawGraph as unknown as ComfyApiGraph;

/**
 * The node whose `image` widget names the file ComfyUI will load.
 *
 * This is deliberately *not* a manifest input. Manifest inputs are the knobs a
 * user turns, and their values come out of `GenerationParams` via the
 * compiler's fixed set of bindings; the init image's filename comes from
 * somewhere else entirely — a file this API has just pushed into the backend's
 * own input folder, whose name only exists after that transfer succeeded. Faking
 * it as a user parameter would mean either inventing a binding the compiler
 * cannot resolve (leaving the graph's placeholder silently in place, which
 * validates and then loads the wrong image) or letting the UI name a file on the
 * backend's disk. So it is set explicitly, after compilation, by the caller that
 * did the transfer — see {@link withInitImage} in ./init-image.ts.
 */
export const IMG2IMG_INIT_IMAGE_NODE_ID = '10';

const INPUTS: readonly ManifestInput[] = [
  {
    path: '4.inputs.ckpt_name',
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
    path: '7.inputs.text',
    source: 'negativePrompt',
    label: 'Negative prompt',
    constraint: { kind: 'string', maxLength: 4000 },
    required: false,
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
    constraint: { kind: 'int', min: 1, max: 100, step: 1 },
    required: true,
  },
  {
    path: '3.inputs.cfg',
    source: 'guidance',
    label: 'Guidance',
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
    label: 'Strength',
    /**
     * The convention txt2img's manifest set up, now load-bearing: the compiler
     * resolves the `denoise` binding from the `init` reference's `influence`
     * slider (see `initDenoise` in compiler/compile.ts), so binding the source
     * to this path is all it takes to wire the slider to the sampler.
     *
     * `required: true` is doing real work here. img2img without an init
     * reference is a contradiction, and the compiler's missing-value check is
     * the only place that catches it before dispatch — without it the request
     * would compile against the graph's own 0.6 literal and quietly generate
     * from whatever image the placeholder names.
     *
     * The floor is 0.05 rather than 0: at 0 the sampler runs zero steps and
     * returns the input unchanged, which is GPU time and a library row spent
     * to produce a copy of a file the user already has.
     */
    constraint: { kind: 'float', min: 0.05, max: 1 },
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

export const img2imgSdxlManifest: WorkflowManifest = {
  id: 'img2img-sdxl',
  version: 1,
  label: 'Image to image (SDXL)',
  capability: 'img2img',
  // The same family aliases txt2img accepts; see the note there.
  baseModels: ['sdxl', 'SDXL 1.0', 'pony', 'illustrious'],
  requiredNodeClasses: [
    'CheckpointLoaderSimple',
    'CLIPTextEncode',
    'LoadImage',
    'VAEEncode',
    'KSampler',
    'VAEDecode',
    'SaveImage',
  ],
  outputNodeId: '9',
  inputs: INPUTS,
  resolutions: SDXL_RESOLUTIONS,
  quality: QUALITY_PRESETS,
  lora: { anchorNodeId: '4', modelSlot: 0, clipSlot: 1, maxLoras: 8 },
};

export const img2imgSdxlTemplate: WorkflowTemplate = {
  manifest: img2imgSdxlManifest,
  graph: img2imgSdxlGraph,
};
