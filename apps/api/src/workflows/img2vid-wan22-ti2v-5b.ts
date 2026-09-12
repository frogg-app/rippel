/**
 * img2vid for Wan 2.2 TI2V 5B — the best image-to-video quality that fits on a
 * 16 GB card.
 *
 * Built from ComfyUI 0.35's own `video_wan2_2_5B_ti2v` library template, which
 * the backend serves at `/templates/video_wan2_2_5B_ti2v.json`, rather than from
 * memory. Every node class and input name below was read back from
 * `/object_info` on 192.168.1.10:8188 on 2026-09-12.
 *
 * ## Why this is not shaped like the other video templates
 *
 *  - **`Wan22ImageToVideoLatent` (55), not `WanImageToVideo`.** The 5B TI2V
 *    checkpoint is a single unified text-and-image model, so the first frame is
 *    encoded straight into the initial latent by one node that takes the VAE and
 *    an optional `start_image`. `WanImageToVideo` is the 14B path, which also
 *    needs CLIP-Vision and a high/low-noise expert pair, and none of that
 *    applies here. `start_image` being *optional* on the node is why the same
 *    graph could serve txt2vid later; it does not today, because this manifest
 *    declares `img2vid` and the picture is the point.
 *  - **`CreateVideo` (57) + `SaveVideo` (58), not `SaveWEBM`.** This is the pair
 *    the library uses: `CreateVideo` takes the decoded frames and a frame rate
 *    and produces a VIDEO, and `SaveVideo` muxes it. With `format` and `codec`
 *    both "auto" it writes an mp4. Verified against the live backend by running
 *    `LoadImage -> CreateVideo -> SaveVideo` on its own, which needs no weights:
 *    `/history` reported the file under `images`, which is one of the two keys
 *    `orchestrator/collect.ts` already reads, so the collector needs no change.
 *  - **`ModelSamplingSD3` (48) at shift 8.** Wan 2.2 needs the shifted sigma
 *    schedule; the reference template pins 8 and so do we. It is unbound on
 *    purpose — it is a property of the model, not a knob a user should hold.
 *  - **fps is bound in one place, not two.** The other video families condition
 *    the model on the frame rate *and* tell the muxer, so they bind `fps` twice.
 *    Wan 2.2 TI2V does not take a rate as conditioning at all: the sampler knows
 *    nothing about it and only `CreateVideo` does. Binding it once is therefore
 *    correct here and would be a bug in the LTX templates.
 *
 * ## The first frame arrives at node 10
 *
 * The library numbers its `LoadImage` 56. This graph numbers it **10**, and
 * that is load-bearing: `orchestrator/dispatch.ts` calls
 * `withInitImage(graph, reference)` with no node id, so the picture is always
 * written to `IMG2IMG_INIT_IMAGE_NODE_ID`, which is '10'. Every other node keeps
 * the library's id so the correspondence stays readable — this graph is also the
 * hand-made answer that Run 2's library converter has to reproduce.
 *
 * `56` is left unused rather than renumbered down, for the same reason.
 *
 * ## What it needs on the backend
 *
 * Three files, none of them bundled together: the transformer in
 * `diffusion_models/`, the UMT5 encoder in `text_encoders/`, and the Wan 2.2 VAE
 * in `vae/`. `UNETLoader` yields MODEL alone, so the encoder and the VAE are
 * genuine companions and are declared as `requires` — a backend missing either
 * gets "needs another model first" with a download attached, rather than a
 * failed job.
 */

import type {
  ComfyApiGraph,
  ManifestInput,
  ModelRequirement,
  WorkflowManifest,
  WorkflowTemplate,
} from './types.js';
import {
  MAX_SEED,
  WAN22_FRAME_QUANTUM,
  WAN22_MAX_FPS,
  WAN22_MAX_FRAMES,
  WAN22_MIN_FPS,
  WAN22_MIN_FRAMES,
  WAN22_QUALITY_PRESETS,
  WAN22_TI2V_RESOLUTIONS,
  WAN22_SAMPLERS,
  WAN22_SCHEDULERS,
} from './presets.js';
import rawGraph from './graphs/img2vid-wan22-ti2v-5b.api.json' with { type: 'json' };

export const img2vidWan22Ti2v5bGraph = rawGraph as unknown as ComfyApiGraph;

/**
 * Family spellings this template accepts.
 *
 * Short, because the registry's `normalizeBaseModel` folds case and strips
 * every non-alphanumeric before it looks anything up: "wan2.2-ti2v-5b",
 * "Wan 2.2 TI2V 5B" and "wan2.2_ti2v_5B" are all the one key `wan22ti2v5b`, and
 * listing them separately is not extra coverage — it is the same key twice,
 * which the index rejects as two templates claiming one family. The second
 * entry is here because it is a genuinely different key: catalogues that lead
 * with the size rather than the task do occur.
 */
export const WAN22_TI2V_5B_BASE_MODELS = ['wan2.2-ti2v-5b', 'wan2.2-5b-ti2v'];

/**
 * The UMT5 text encoder.
 *
 * Wan uses UMT5-XXL, not the T5-XXL the LTX and FLUX graphs load, and they are
 * not interchangeable — `CLIPLoader` is told `type: "wan"` and reads a different
 * tensor layout. So this is its own requirement object rather than a reuse of
 * `LTXV_TEXT_ENCODER_REQUIREMENT`, and the filename pattern insists on "umt5"
 * for exactly that reason: a backend holding only `t5xxl_fp16.safetensors` must
 * report a missing encoder, not silently load the wrong one.
 *
 * Only the fp8 scaled build is preferred: it is the one ComfyUI's own repackaged
 * repo ships for this template, at 6.27 GB. It is loaded, used and freed before
 * the 9.31 GB transformer comes in, so the two never share the card — but an
 * fp16 UMT5 would not fit even on its own alongside the latents.
 */
export const WAN22_TEXT_ENCODER_REQUIREMENT: ModelRequirement = {
  id: 'text-encoder',
  path: '38.inputs.clip_name',
  modelType: 'clip',
  label: 'UMT5 text encoder',
  why:
    'Wan 2.2 conditions on UMT5-XXL, and the transformer file holds no text encoder, ' +
    'so the prompt cannot be encoded without it. A T5-XXL will not substitute: it is a ' +
    'different model with a different tensor layout.',
  match: {
    filename: /umt5/i,
    catalogueBase: ['wan', 'wan2.1', 'wan2.2', 'umt5'],
    catalogueFilename: /umt5/i,
  },
  preferred: ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'],
};

/**
 * The Wan 2.2 VAE.
 *
 * The 5B TI2V model uses the *new* Wan 2.2 VAE with a higher compression ratio,
 * and the Wan 2.1 VAE will not decode its latents. The pattern therefore anchors
 * on the version rather than matching any `wan*vae`, because loading the 2.1 VAE
 * here produces a clip of noise rather than an error, which is the worst
 * possible outcome. This is not hypothetical: `wan_2.1_vae.safetensors` sits in
 * the same `split_files/vae/` directory of the same repo as the 2.2 one, so a
 * pattern matching `wan.*vae` would find both.
 */
export const WAN22_VAE_REQUIREMENT: ModelRequirement = {
  id: 'vae',
  path: '39.inputs.vae_name',
  modelType: 'vae',
  label: 'Wan 2.2 VAE',
  why:
    'Loading the transformer from diffusion_models gives no VAE, so the one that decodes ' +
    'its latents into frames has to come from the vae folder as a separate file. It must be ' +
    'the 2.2 VAE: the 2.1 one has a different compression ratio and silently decodes noise.',
  match: {
    filename: /wan2[._]?2.*vae|vae.*wan2[._]?2/i,
    catalogueBase: ['wan', 'wan2.2'],
    catalogueFilename: /wan2[._]?2.*vae/i,
  },
  preferred: ['wan2.2_vae.safetensors'],
};

export const WAN22_TI2V_REQUIREMENTS: readonly ModelRequirement[] = [
  WAN22_TEXT_ENCODER_REQUIREMENT,
  WAN22_VAE_REQUIREMENT,
];

const INPUTS: readonly ManifestInput[] = [
  {
    path: '37.inputs.unet_name',
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
    // Optional, so an omitted negative leaves the graph's literal standing —
    // which is Wan's own Chinese quality-negative string, the one the reference
    // template ships. Sending an empty string instead would throw it away.
    path: '7.inputs.text',
    source: 'negativePrompt',
    label: 'Negative prompt',
    constraint: { kind: 'string', maxLength: 4000 },
    required: false,
  },
  {
    path: '55.inputs.width',
    source: 'width',
    label: 'Width',
    // 32 is the node's own declared step, not a guess.
    constraint: { kind: 'int', min: 256, max: 1280, step: 32 },
    required: true,
  },
  {
    path: '55.inputs.height',
    source: 'height',
    label: 'Height',
    constraint: { kind: 'int', min: 256, max: 1280, step: 32 },
    required: true,
  },
  {
    path: '55.inputs.batch_size',
    source: 'batchSize',
    label: 'Clips',
    // Two at most, and only because the node allows it. The Wan 2.2 VAE decodes
    // a whole clip as one tensor, so a second one is a second full decode.
    constraint: { kind: 'int', min: 1, max: 2, step: 1 },
    required: true,
  },
  {
    path: '55.inputs.length',
    source: 'frameCount',
    label: 'Frames',
    // Derived from length and rate, then snapped to 4n+1. See WAN22_FRAME_QUANTUM.
    constraint: { kind: 'int', min: WAN22_MIN_FRAMES, max: WAN22_MAX_FRAMES, step: 1 },
    required: true,
  },
  {
    // The only place a frame rate appears in this graph; see the header.
    path: '57.inputs.fps',
    source: 'fps',
    label: 'Frame rate',
    constraint: { kind: 'int', min: WAN22_MIN_FPS, max: WAN22_MAX_FPS, step: 1 },
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
    path: '3.inputs.sampler_name',
    source: 'sampler',
    label: 'Sampler',
    constraint: { kind: 'enum', values: WAN22_SAMPLERS },
    required: true,
  },
  {
    path: '3.inputs.scheduler',
    source: 'scheduler',
    label: 'Scheduler',
    constraint: { kind: 'enum', values: WAN22_SCHEDULERS },
    required: true,
  },
  {
    path: '58.inputs.filename_prefix',
    source: 'filenamePrefix',
    label: 'Filename prefix',
    constraint: { kind: 'string', maxLength: 200 },
    required: false,
  },
  // No `motion` binding: Wan 2.2 TI2V has no motion knob. SVD has a trained
  // motion bucket and LTX-Video has conditioning-image compression; this family
  // has neither, so asking for one is an error rather than a no-op.
];

export const img2vidWan22Ti2v5bManifest: WorkflowManifest = {
  id: 'img2vid-wan22-ti2v-5b',
  version: 1,
  label: 'Image to video (Wan 2.2 TI2V 5B)',
  capability: 'img2vid',
  baseModels: WAN22_TI2V_5B_BASE_MODELS,
  requires: WAN22_TI2V_REQUIREMENTS,
  requiredNodeClasses: [
    'UNETLoader',
    'CLIPLoader',
    'VAELoader',
    'ModelSamplingSD3',
    'CLIPTextEncode',
    'LoadImage',
    'Wan22ImageToVideoLatent',
    'KSampler',
    'VAEDecode',
    'CreateVideo',
    'SaveVideo',
  ],
  outputNodeId: '58',
  inputs: INPUTS,
  resolutions: WAN22_TI2V_RESOLUTIONS,
  quality: WAN22_QUALITY_PRESETS,
  frameQuantum: WAN22_FRAME_QUANTUM,
  // No `lora`: Wan LoRAs exist, but they attach to the 14B expert pair rather
  // than this unified 5B model, and none is installed to test against.
};

export const img2vidWan22Ti2v5bTemplate: WorkflowTemplate = {
  manifest: img2vidWan22Ti2v5bManifest,
  graph: img2vidWan22Ti2v5bGraph,
};
