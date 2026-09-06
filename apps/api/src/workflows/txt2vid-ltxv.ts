/**
 * txt2vid for the LTX-Video family.
 *
 * LTX-Video is the family this product can plausibly run on a 16 GB consumer
 * card: a 2B DiT that samples a whole clip in one pass at a few dozen steps,
 * where the alternatives on the test hardware either cannot load at all
 * (`hunyuan_video_720p_fp8_e4m3fn.safetensors` is a truncated file — ComfyUI
 * raises `SafetensorError: header too large` and always will) or want more VRAM
 * than exists. The family string `ltx-video` is what `models/family.ts` infers
 * from the filename, so it is what `baseModels` has to list.
 *
 * -------------------------------------------------------------------- shape
 *
 * The graph is txt2img-sdxl's skeleton with three substitutions, and the node
 * ids of everything they share are kept so a dumped graph from any template in
 * this repo reads the same way (4 = model loader, 6/7 = the text encodes,
 * 5 = the empty latent, 3 = the sampler, 8 = decode, 9 = save):
 *
 *  - **The text encoder is a separate file.** An LTX-Video checkpoint holds the
 *    transformer and the VAE but no text encoder, so `CheckpointLoaderSimple`'s
 *    CLIP output is null and node 12 loads T5-XXL with `type: "ltxv"` instead.
 *    That filename is a graph literal rather than a manifest input, because
 *    `GenerationParams` has no field for a text encoder and should not gain
 *    one — the user picks a checkpoint, not an encoder. It used to be a plain
 *    hardcoded string, which meant an operator whose T5 lived in a subfolder
 *    (`t5/t5xxl_fp8_e4m3fn.safetensors`, which is where ComfyUI-Manager files
 *    it) had a graph naming a file they did not have. It is now backed by a
 *    `ModelRequirement` — see `LTXV_TEXT_ENCODER_REQUIREMENT` below and
 *    requirements.ts — so the literal is only the last-resort default and the
 *    encoder actually loaded is whichever one the backend reports.
 *  - **`LTXVConditioning` (13) sits between the encodes and the sampler.** The
 *    model conditions on the frame rate it is generating for, so `fps` is not
 *    only a property of the container — a clip conditioned at 25 and muxed at 8
 *    is 97 correct frames played wrongly. Both paths take the same binding.
 *  - **`SamplerCustom` (3) replaces `KSampler`.** LTX-Video needs the shifted
 *    sigma schedule `LTXVScheduler` (15) produces; a stock scheduler enum makes
 *    a clip that never resolves. So `steps` binds to the scheduler node and the
 *    sampler node takes only the integrator, from `KSamplerSelect` (14). This
 *    is also why `LTXV_QUALITY_PRESETS.scheduler` reaches nothing.
 *
 * The output is a real video container: `SaveWEBM` muxes VP9 and reports its
 * file under `images` in `/history`, which is one of the two keys the
 * orchestrator's collector already reads.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE BACKEND SAID — this graph, compiled and posted to ComfyUI 0.34 at
 * 192.168.1.10:8188 on 2026-09-06. It has **not** produced a clip, and the
 * reason is worth recording precisely, because none of it is the graph:
 *
 *   POST /prompt -> 400 prompt_outputs_failed_validation, with exactly two
 *   node_errors and no others:
 *     4  ckpt_name: 'ltx-video-2b-v0.9.1.safetensors' not in
 *        ['SDXL\sd_xl_base_1.0.safetensors', 'hunyuan_video_720p_fp8_e4m3fn.safetensors']
 *     12 clip_name: 't5xxl_fp16.safetensors' not in []
 *
 * Both are missing *files*, not wrong wiring: ComfyUI validates class names,
 * links, and every required input before it reports these, so everything else
 * in the graph was accepted. Two things have to be true on the box:
 *
 *  1. **The LTX-Video file is filed under `diffusion_models/`, not
 *     `checkpoints/`.** ComfyUI-Manager's own catalogue installs it to
 *     `checkpoints/LTXV/`, and only `CheckpointLoaderSimple` yields the VAE
 *     that lives inside that file — `UNETLoader`, which is the only loader that
 *     can currently see it, returns MODEL alone and there is no separate
 *     LTX-Video VAE to pair with it. Loading it *does* work, incidentally: a
 *     probe through `UNETLoader` got as far as `LTXBaseModel.forward()`, so the
 *     weights are fine and only the folder is wrong.
 *  2. **No T5 text encoder is installed at all** — `text_encoders/` is empty,
 *     which is why node 12's combo has no options. LTX-Video cannot be
 *     conditioned without one.
 *
 * Not a blocker but worth knowing: the box's other video checkpoint,
 * `hunyuan_video_720p_fp8_e4m3fn.safetensors`, is a truncated file that raises
 * `SafetensorError: header too large`, and it needs a text encoder it also does
 * not have. LTX-Video is the only video family here with a route to running.
 * ---------------------------------------------------------------------------
 */

import type {
  ComfyApiGraph,
  ManifestInput,
  ModelRequirement,
  WorkflowManifest,
  WorkflowTemplate,
} from './types.js';
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
import rawGraph from './graphs/txt2vid-ltxv.api.json' with { type: 'json' };

/** See the note on the identical cast in txt2img-sdxl.ts. */
export const txt2vidLtxvGraph = rawGraph as unknown as ComfyApiGraph;

/**
 * Every spelling of the family we accept.
 *
 * Only spellings that survive `normalizeBaseModel` as *distinct* keys may be
 * listed: it strips case and punctuation, so "LTX-Video" and "ltx video" both
 * collapse onto "ltxvideo" and listing both would trip the registry's
 * duplicate-registration guard at import time. "ltx-video" is what
 * `family.ts` records; "ltxv" is what ComfyUI-Manager's catalogue and most
 * filenames say.
 */
export const LTXV_BASE_MODELS = ['ltx-video', 'ltxv'] as const;

/**
 * The T5 this family cannot run without.
 *
 * Shared by both LTX-Video templates: node 12 is the same `CLIPLoader` in
 * txt2vid and img2vid, so the requirement is the same object and cannot drift
 * between them.
 *
 * This entry replaces the wart the header of this file used to describe. The
 * graph literal `t5xxl_fp16.safetensors` stays as the last-resort default — the
 * graph doubles as its own defaults everywhere else in this directory too — but
 * it is no longer what actually gets loaded: `withResolvedRequirements` looks at
 * what the backend offers for `CLIPLoader.clip_name` and writes that in. An
 * operator who installed the fp8 build, or whose Manager filed the fp16 one
 * under `text_encoders/t5/`, now gets the file they have.
 *
 * `type: "ltxv"` on node 12 is *not* a requirement: it is a mode switch on the
 * loader, not a file, and every T5-XXL build works under it.
 */
export const LTXV_TEXT_ENCODER_REQUIREMENT: ModelRequirement = {
  id: 'text-encoder',
  path: '12.inputs.clip_name',
  modelType: 'clip',
  label: 'T5 text encoder',
  why:
    'An LTX-Video checkpoint holds the transformer and the VAE but no text encoder, ' +
    'so there is nothing to turn the prompt into conditioning without a separate T5.',
  match: {
    // Loose on purpose: `t5xxl_fp16.safetensors`, `t5/t5xxl_fp8_e4m3fn.safetensors`
    // and `t5\t5xxl_fp16.safetensors` must all match, because all three are
    // spellings the same file arrives under.
    filename: /t5/i,
    // ComfyUI-Manager's catalogue files every T5-XXL build under base "t5",
    // including the ones it describes as "Text Encoders for FLUX" — the same
    // weights, and what LTX-Video's own reference workflow uses.
    catalogueBase: ['t5'],
    catalogueFilename: /t5xxl/i,
  },
  // fp16 is the reference build; the fp8s are the ones that fit on a 16 GB card
  // alongside the transformer, and are ordered after it only because a backend
  // that has both should use the better one.
  preferred: [
    't5xxl_fp16.safetensors',
    't5xxl_fp8_e4m3fn_scaled.safetensors',
    't5xxl_fp8_e4m3fn.safetensors',
  ],
};

/** Every companion model the LTX-Video graphs load. */
export const LTXV_REQUIREMENTS: readonly ModelRequirement[] = [LTXV_TEXT_ENCODER_REQUIREMENT];

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
    // T5 has no 77-token window to chunk around, and LTX-Video responds to long
    // descriptive prompts far better than to tag soup; the cap is the same
    // storage-hygiene limit the SDXL templates use, not a model limit.
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
    path: '5.inputs.width',
    source: 'width',
    label: 'Width',
    // 32-step multiples, and a much lower ceiling than SDXL's: see the note on
    // LTXV_RESOLUTIONS for why the cost here is per frame, times a hundred.
    constraint: { kind: 'int', min: 256, max: 1024, step: 32 },
    required: true,
  },
  {
    path: '5.inputs.height',
    source: 'height',
    label: 'Height',
    constraint: { kind: 'int', min: 256, max: 1024, step: 32 },
    required: true,
  },
  {
    path: '5.inputs.batch_size',
    source: 'batchSize',
    label: 'Clips',
    // Not 8, as SDXL allows. A batch of two clips is two whole latent videos
    // resident at once; on the hardware this family exists for, that is already
    // the point where the decode fails.
    constraint: { kind: 'int', min: 1, max: 2, step: 1 },
    required: true,
  },
  {
    path: '5.inputs.length',
    source: 'frameCount',
    label: 'Frames',
    /**
     * Derived, never sent: the compiler computes `lengthSeconds * fps` and
     * snaps it onto this family's `8n + 1` grid (see `videoFrameCount`). The
     * bounds below are checked against the *snapped* value, so a request that
     * rounds up past the ceiling is rejected rather than quietly clipped.
     */
    constraint: { kind: 'int', min: LTXV_MIN_FRAMES, max: LTXV_MAX_FRAMES, step: 1 },
    required: true,
  },
  {
    path: '13.inputs.frame_rate',
    source: 'fps',
    label: 'Frame rate',
    // The conditioning half of the pair. LTXVConditioning takes a FLOAT, but we
    // constrain to whole frames per second: nothing downstream benefits from
    // 23.976 and the asset row would then disagree with the container.
    constraint: { kind: 'int', min: LTXV_MIN_FPS, max: LTXV_MAX_FPS, step: 1 },
    required: true,
  },
  {
    path: '9.inputs.fps',
    source: 'fps',
    label: 'Frame rate',
    // The container half. Same source, deliberately: a clip conditioned at one
    // rate and muxed at another plays at the wrong speed with every frame
    // correct, which is a bug nobody thinks to look for.
    constraint: { kind: 'int', min: LTXV_MIN_FPS, max: LTXV_MAX_FPS, step: 1 },
    required: true,
  },
  {
    path: '3.inputs.noise_seed',
    source: 'seed',
    label: 'Seed',
    // `noise_seed`, not `seed` — SamplerCustom names it differently from
    // KSampler, and an unknown key in `inputs` is silently ignored by ComfyUI,
    // so the wrong name here would pin every clip to the graph's literal 0.
    constraint: { kind: 'int', min: 0, max: MAX_SEED, step: 1 },
    required: true,
  },
  {
    path: '15.inputs.steps',
    source: 'steps',
    label: 'Steps',
    // On the scheduler, not the sampler: SamplerCustom has no step count, it
    // takes however many sigmas it is handed. Ceiling is 60 because LTX-Video
    // 2B has visibly converged by ~30 and the rest is a minute of GPU time.
    constraint: { kind: 'int', min: 4, max: 60, step: 1 },
    required: true,
  },
  {
    path: '3.inputs.cfg',
    source: 'guidance',
    label: 'Guidance',
    // Far tighter than SDXL's 1-20. LTX-Video wants ~3; past ~8 the clip
    // saturates and the motion tears.
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
];

export const txt2vidLtxvManifest: WorkflowManifest = {
  id: 'txt2vid-ltxv',
  version: 1,
  label: 'Text to video (LTX-Video)',
  capability: 'txt2vid',
  baseModels: LTXV_BASE_MODELS,
  requires: LTXV_REQUIREMENTS,
  requiredNodeClasses: [
    'CheckpointLoaderSimple',
    'CLIPLoader',
    'CLIPTextEncode',
    'EmptyLTXVLatentVideo',
    'LTXVConditioning',
    'KSamplerSelect',
    'LTXVScheduler',
    'SamplerCustom',
    'VAEDecode',
    'SaveWEBM',
  ],
  outputNodeId: '9',
  inputs: INPUTS,
  resolutions: LTXV_RESOLUTIONS,
  quality: LTXV_QUALITY_PRESETS,
  frameQuantum: LTXV_FRAME_QUANTUM,
  // No `lora`. LTX-Video LoRAs exist, but the chain the compiler splices
  // repoints CLIP consumers at the loader chain's tail, and this graph's CLIP
  // comes from a different node than its MODEL. Wiring that correctly is a
  // separate change; claiming support we cannot deliver would let a request
  // through that silently ignores the LoRA.
};

export const txt2vidLtxvTemplate: WorkflowTemplate = {
  manifest: txt2vidLtxvManifest,
  graph: txt2vidLtxvGraph,
};
