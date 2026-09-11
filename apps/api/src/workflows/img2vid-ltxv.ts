/**
 * img2vid for the LTX-Video family — the "Animate" action on every image.
 *
 * This is `txt2vid-ltxv` with the empty latent (node 5) replaced by a
 * `LoadImage` -> `LTXVPreprocess` -> `LTXVImgToVideo` run (nodes 10, 17, 18),
 * exactly as img2img-sdxl is txt2img-sdxl with a `LoadImage` -> `VAEEncode`
 * pair. Everything else keeps its node id and its wiring.
 *
 * Three things about that substitution are not obvious:
 *
 *  - **`LTXVImgToVideo` produces conditioning *and* the latent.** It outputs
 *    (CONDITIONING, CONDITIONING, LATENT): it encodes the first frame with the
 *    VAE, builds the noise stack around it, and rewrites both conditionings to
 *    carry the guide. So the text encodes feed *it*, and `LTXVConditioning`
 *    (13) then takes its two outputs rather than the encodes' — getting that
 *    order wrong produces a clip that ignores the image without erroring.
 *  - **Unlike img2img, this template *does* bind width, height and batch.**
 *    img2img inherits its size from the pixels it was handed; `LTXVImgToVideo`
 *    resizes the first frame to the size it is told, because the clip's size is
 *    a property of the model's buckets, not of whatever the user dropped in.
 *  - **`motion` is `img_compression`, and that is not a hack.** LTX-Video has
 *    no motion-bucket input. What it has is the documented behaviour that a
 *    cleaner conditioning frame is one the model is more willing to hold still
 *    on, so `LTXVPreprocess` (17) degrading the guide is the family's actual
 *    motion control — 0 is a near-frozen shot, 100 departs from the source
 *    fastest. `VideoParams.motion` is explicitly "backend-specific motion
 *    amount", so the manifest's 0..100 range is what the UI's slider becomes.
 *
 * `VideoParams.lastFrame` is *not* offered. LTX-Video 0.9.1 conditions on one
 * guide frame; interpolating to a target needs `LTXVAddGuide` and a model
 * trained for it, and binding it here would give the UI a control that changes
 * nothing. The manifest omitting it is how the Create screen knows not to show
 * it.
 */

import type { ManifestInput, WorkflowManifest, WorkflowTemplate, ComfyApiGraph } from './types.js';
import {
  LTXV_BASE_MODELS,
  LTXV_REQUIREMENTS,
} from './txt2vid-ltxv.js';
import {
  LTXV_FRAME_QUANTUM,
  LTXV_MAX_FPS,
  LTXV_MAX_FRAMES,
  LTXV_MIN_FPS,
  LTXV_MIN_FRAMES,
  LTXV_QUALITY_PRESETS,
  LTXV_RESOLUTIONS,
  LTXV_SAMPLERS,
  MAX_SEED,
} from './presets.js';
import rawGraph from './graphs/img2vid-ltxv.api.json' with { type: 'json' };

/** See the note on the identical cast in txt2img-sdxl.ts. */
export const img2vidLtxvGraph = rawGraph as unknown as ComfyApiGraph;

/**
 * The node whose `image` widget names the first frame on the backend's disk.
 *
 * Deliberately not a manifest input, for the reason spelled out at
 * `IMG2IMG_INIT_IMAGE_NODE_ID` in img2img-sdxl.ts: the name only exists after a
 * transfer has succeeded, and it names a file on someone else's machine.
 *
 * It is also deliberately the *same id*, '10'. `VideoParams.firstFrame` is an
 * `ImageSource` exactly like an img2img init reference, arrives by exactly the
 * same route, and so is delivered by exactly the same code —
 * {@link withInitImage} in ./init-image.ts, whose default node id this is. A
 * second transfer path for video would be a second place to get the ComfyUI
 * upload semantics wrong.
 */
export const IMG2VID_FIRST_FRAME_NODE_ID = '10';

export const IMG2VID_LTXV_INPUTS: readonly ManifestInput[] = [
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
    path: '18.inputs.width',
    source: 'width',
    label: 'Width',
    constraint: { kind: 'int', min: 256, max: 1024, step: 32 },
    required: true,
  },
  {
    path: '18.inputs.height',
    source: 'height',
    label: 'Height',
    constraint: { kind: 'int', min: 256, max: 1024, step: 32 },
    required: true,
  },
  {
    path: '18.inputs.batch_size',
    source: 'batchSize',
    label: 'Clips',
    constraint: { kind: 'int', min: 1, max: 2, step: 1 },
    required: true,
  },
  {
    path: '18.inputs.length',
    source: 'frameCount',
    label: 'Frames',
    // Derived and snapped to 8n+1, same as txt2vid; note `LTXVImgToVideo`
    // declares a floor of 9 where the empty-latent node allows 1, because a
    // guide frame plus nothing is not a clip.
    constraint: { kind: 'int', min: LTXV_MIN_FRAMES, max: LTXV_MAX_FRAMES, step: 1 },
    required: true,
  },
  {
    path: '17.inputs.img_compression',
    source: 'motion',
    label: 'Motion',
    // See the header: this *is* the motion control for this family. The range
    // is the node's own 0..100, which is what the UI's slider will span.
    constraint: { kind: 'int', min: 0, max: 100, step: 1 },
    // Optional: omitted, the graph's own 35 stands, which is Lightricks' default.
    required: false,
  },
  {
    path: '13.inputs.frame_rate',
    source: 'fps',
    label: 'Frame rate',
    constraint: { kind: 'int', min: LTXV_MIN_FPS, max: LTXV_MAX_FPS, step: 1 },
    required: true,
  },
  {
    path: '9.inputs.fps',
    source: 'fps',
    label: 'Frame rate',
    constraint: { kind: 'int', min: LTXV_MIN_FPS, max: LTXV_MAX_FPS, step: 1 },
    required: true,
  },
  {
    path: '3.inputs.noise_seed',
    source: 'seed',
    label: 'Seed',
    constraint: { kind: 'int', min: 0, max: MAX_SEED, step: 1 },
    required: true,
  },
  {
    path: '15.inputs.steps',
    source: 'steps',
    label: 'Steps',
    constraint: { kind: 'int', min: 4, max: 60, step: 1 },
    required: true,
  },
  {
    path: '3.inputs.cfg',
    source: 'guidance',
    label: 'Guidance',
    constraint: { kind: 'float', min: 1, max: 10 },
    required: true,
  },
  {
    path: '14.inputs.sampler_name',
    source: 'sampler',
    label: 'Sampler',
    constraint: { kind: 'enum', values: LTXV_SAMPLERS },
    required: true,
  },
  {
    path: '9.inputs.filename_prefix',
    source: 'filenamePrefix',
    label: 'Filename prefix',
    constraint: { kind: 'string', maxLength: 200 },
    required: false,
  },
  // `18.inputs.strength` is intentionally unbound and pinned at 1.0 in the
  // graph. It is how strongly the first frame is imposed on the latent, and at
  // anything below 1 the clip does not start from the picture the user picked —
  // which is the one thing "Animate this image" promises.
];

export const img2vidLtxvManifest: WorkflowManifest = {
  id: 'img2vid-ltxv',
  version: 1,
  label: 'Image to video (LTX-Video)',
  capability: 'img2vid',
  baseModels: LTXV_BASE_MODELS,
  // The same object txt2vid uses: node 12 is the same CLIPLoader in both
  // graphs, so sharing it is what stops the two drifting apart.
  requires: LTXV_REQUIREMENTS,
  requiredNodeClasses: [
    'CheckpointLoaderSimple',
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
  inputs: IMG2VID_LTXV_INPUTS,
  resolutions: LTXV_RESOLUTIONS,
  quality: LTXV_QUALITY_PRESETS,
  frameQuantum: LTXV_FRAME_QUANTUM,
  // No `lora`, for the reason given on txt2vid-ltxv's manifest.
};

export const img2vidLtxvTemplate: WorkflowTemplate = {
  manifest: img2vidLtxvManifest,
  graph: img2vidLtxvGraph,
};
