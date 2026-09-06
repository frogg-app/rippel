/**
 * The generic Stable-Diffusion templates: what we run when nothing specific
 * matches.
 *
 * ## Why this exists
 *
 * Until now a checkpoint could only be generated with if its inferred family
 * had a hand-authored template. On a real box that means a user installs a
 * checkpoint and cannot use it *at all* until someone writes a template for it,
 * which is a terrible answer to give about a file that would have worked. The
 * overwhelming majority of community checkpoints — SD 1.5, SDXL, Pony,
 * Illustrious, NoobAI and the endless merges of them — run on one node set:
 *
 *   CheckpointLoaderSimple -> 2x CLIPTextEncode -> EmptyLatentImage
 *                          -> KSampler -> VAEDecode -> SaveImage
 *
 * That is the graph in `graphs/txt2img-sd-generic.api.json`, and it is
 * byte-for-byte the shape of `txt2img-sdxl` — deliberately, so that a graph
 * dumped from a failed generic job reads exactly like one from the reference
 * template.
 *
 * ## Why it is not a blanket "try anything"
 *
 * A video checkpoint pointed at this graph fails *after* real GPU time, and a
 * confident failure is worse than an honest refusal. So the coverage is an
 * allow-list, not a catch-all: the templates below name the families they apply
 * to, plus one that answers for a model whose family we could not infer at all
 * (`Model.baseModel IS NULL`) on the grounds that an unrecognised checkpoint is
 * far more likely to be an SD-family merge than anything else. Families that
 * need a different graph are enumerated in {@link NON_SD_NODE_SET_FAMILIES} and
 * the registry refuses at import time to let a fallback claim one.
 *
 * ## Why there is more than one of them per capability
 *
 * Resolution. SDXL wants ~1024 on the long edge; SD 1.5 produces mangled,
 * duplicated compositions at 1024 and wants ~512. A manifest carries exactly one
 * `ResolutionTable`, so "the fallback" is really one graph with a manifest per
 * *resolution tier* — see the long note on `SD15_RESOLUTIONS` and
 * `GENERIC_SD_RESOLUTIONS` in presets.ts, which is where that decision is
 * argued.
 *
 * ## Why every one of them is flagged
 *
 * `isFallback: true` is on all four. A generic graph is a best guess: the nodes
 * are right for the family but nobody has run *this* checkpoint through them,
 * and the presets are the SDXL community defaults rather than anything tuned.
 * The flag is what lets the API and the UI say "using a generic workflow for
 * this model" instead of implying the confidence of a hand-authored template.
 */

import type { ManifestInput, WorkflowManifest, WorkflowTemplate, ComfyApiGraph } from './types.js';
import {
  GENERIC_SD_RESOLUTIONS,
  MAX_SEED,
  QUALITY_PRESETS,
  SD15_RESOLUTIONS,
  SDXL_SAMPLERS,
  SDXL_SCHEDULERS,
} from './presets.js';
import rawTxt2imgGraph from './graphs/txt2img-sd-generic.api.json' with { type: 'json' };
import rawImg2imgGraph from './graphs/img2img-sd-generic.api.json' with { type: 'json' };

/** See the note on the identical cast in txt2img-sdxl.ts. */
export const txt2imgSdGenericGraph = rawTxt2imgGraph as unknown as ComfyApiGraph;
export const img2imgSdGenericGraph = rawImg2imgGraph as unknown as ComfyApiGraph;

/**
 * Families that must **never** reach a generic template, and why.
 *
 * This is stated explicitly rather than left implicit in the allow-lists below,
 * because the failure it prevents is silent: someone adds a family to a
 * fallback's `baseModels` because "it's a checkpoint, it'll be fine", and the
 * next person to select that model waits for a GPU minute to buy a traceback.
 * The registry asserts no fallback claims anything on this list, so the mistake
 * fails at import time instead.
 *
 * Everything here needs a genuinely *different graph*, not different numbers:
 *
 *  - `hunyuan-video`, `ltx-video`, `svd`, `wan` — video. They sample a latent
 *    *stack*, not an image: `EmptyLatentImage` gives them no temporal axis, and
 *    several (LTX-Video, WAN) carry no usable CLIP in the checkpoint at all and
 *    need a separate text-encoder loader. See txt2vid-ltxv.ts for what that
 *    actually takes.
 *  - `flux.1` — no CheckpointLoaderSimple path worth taking: it wants
 *    `UNETLoader`/`DualCLIPLoader` (T5 + CLIP-L), and it has no negative
 *    conditioning and no cfg, using a `FluxGuidance` node instead. This graph's
 *    negative prompt and cfg 6.5 would be meaningless at best.
 *  - `sd3` — triple text encoder (CLIP-L + CLIP-G + T5) via `TripleCLIPLoader`,
 *    and an MMDiT sampler path. The stock loader does not assemble it.
 *  - `sdxl-turbo` — the one entry here whose *node set* is fine. It is excluded
 *    for the reason `FAMILIES.sdxlTurbo` exists at all: turbo/lightning
 *    distillations want 1-8 steps at cfg ~1, and running them through
 *    `QUALITY_PRESETS` (16-45 steps, cfg 5.5-7) produces a burnt, over-saturated
 *    image. It needs its own preset table, which is a small piece of work
 *    someone should do — not a resolution tier, so it does not belong below.
 */
export const NON_SD_NODE_SET_FAMILIES: readonly string[] = [
  'hunyuan-video',
  'ltx-video',
  'svd',
  'wan',
  'flux.1',
  'sd3',
  'sdxl-turbo',
];

/**
 * Families that use the SD node set *and* SD 1.x-scale latents.
 *
 * The XL-lineage families (`sdxl`, `pony`, `illustrious`) are absent on purpose:
 * they already have hand-authored templates, and if they ever lose them the
 * right fix is to write one, not to have them silently inherit a 640-pixel
 * table. Spellings beyond our own canonical ones are listed because
 * `baseModel` also arrives from Civitai and HuggingFace tags.
 */
const SD15_TIER_FAMILIES: readonly string[] = [
  // Our own canonical spellings, from FAMILIES in models/family.ts.
  'sd1.5',
  'sd2.x',
  // Spellings that reach us from elsewhere. No two may normalise to the same
  // key — the registry throws at import on a collision, and "sd1.5" and "SD 1.5"
  // are already the same key.
  'sd1.x',
  'sd2.0',
  'sd2.1',
];

// ---------------------------------------------------------------- txt2img

/**
 * Node ids are txt2img-sdxl's, unchanged. See the note there: keeping the stock
 * ComfyUI numbering means a dumped graph is readable by anyone who has seen the
 * default workflow, and it means the generic and SDXL graphs diff cleanly
 * against each other.
 */
function txt2imgInputs(maxEdge: number): readonly ManifestInput[] {
  return [
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
      path: '5.inputs.width',
      source: 'width',
      label: 'Width',
      // The ceiling is the tier's, not SDXL's. On the SD 1.x tier it is the
      // difference between a soft image and a duplicated one, so it is not
      // merely advisory: nothing but the resolution table writes here today,
      // but the constraint is also what an Advanced drawer would bound itself
      // to, and it must not offer a size this family cannot draw.
      constraint: { kind: 'int', min: 256, max: maxEdge, step: 64 },
      required: true,
    },
    {
      path: '5.inputs.height',
      source: 'height',
      label: 'Height',
      constraint: { kind: 'int', min: 256, max: maxEdge, step: 64 },
      required: true,
    },
    {
      path: '5.inputs.batch_size',
      source: 'batchSize',
      label: 'Images',
      constraint: { kind: 'int', min: 1, max: 8, step: 1 },
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
      label: 'Denoise',
      constraint: { kind: 'float', min: 0, max: 1 },
      required: false,
    },
    {
      path: '9.inputs.filename_prefix',
      source: 'filenamePrefix',
      label: 'Filename prefix',
      constraint: { kind: 'string', maxLength: 200 },
      required: false,
    },
  ];
}

export const txt2imgSdGenericManifest: WorkflowManifest = {
  id: 'txt2img-sd-generic',
  version: 1,
  label: 'Text to image (generic SD 1.x/2.x)',
  capability: 'txt2img',
  baseModels: SD15_TIER_FAMILIES,
  isFallback: true,
  requiredNodeClasses: [
    'CheckpointLoaderSimple',
    'CLIPTextEncode',
    'EmptyLatentImage',
    'KSampler',
    'VAEDecode',
    'SaveImage',
  ],
  outputNodeId: '9',
  inputs: txt2imgInputs(1024),
  resolutions: SD15_RESOLUTIONS,
  quality: QUALITY_PRESETS,
  lora: { anchorNodeId: '4', modelSlot: 0, clipSlot: 1, maxLoras: 8 },
};

export const txt2imgSdGenericUnknownManifest: WorkflowManifest = {
  id: 'txt2img-sd-generic-unknown',
  version: 1,
  label: 'Text to image (generic, unrecognised model)',
  capability: 'txt2img',
  // Deliberately empty. This template is reached only through the
  // `baseModel === null` path; giving it family aliases would make it compete
  // with the tier above for models we *did* recognise.
  baseModels: [],
  isFallback: true,
  appliesToUnknownFamily: true,
  requiredNodeClasses: txt2imgSdGenericManifest.requiredNodeClasses,
  outputNodeId: '9',
  inputs: txt2imgInputs(1536),
  resolutions: GENERIC_SD_RESOLUTIONS,
  quality: QUALITY_PRESETS,
  lora: { anchorNodeId: '4', modelSlot: 0, clipSlot: 1, maxLoras: 8 },
};

// ---------------------------------------------------------------- img2img

/**
 * As in img2img-sdxl: the empty latent is gone, so there is no width, height or
 * batch binding — the init image's own pixels decide all three — and `denoise`
 * becomes the influence slider rather than a pinned 1.0.
 */
const IMG2IMG_INPUTS: readonly ManifestInput[] = [
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
    // Same reasoning as img2img-sdxl: required, floored at 0.05 so a request
    // cannot spend GPU time returning a copy of the file the user supplied.
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

const IMG2IMG_NODE_CLASSES = [
  'CheckpointLoaderSimple',
  'CLIPTextEncode',
  'LoadImage',
  'VAEEncode',
  'KSampler',
  'VAEDecode',
  'SaveImage',
];

export const img2imgSdGenericManifest: WorkflowManifest = {
  id: 'img2img-sd-generic',
  version: 1,
  label: 'Image to image (generic SD 1.x/2.x)',
  capability: 'img2img',
  baseModels: SD15_TIER_FAMILIES,
  isFallback: true,
  requiredNodeClasses: IMG2IMG_NODE_CLASSES,
  outputNodeId: '9',
  inputs: IMG2IMG_INPUTS,
  // Nothing in this graph consumes it — the init image decides the size — but
  // the compiler resolves the aspect ratio unconditionally, so the table has to
  // be the tier's and not an arbitrary one.
  resolutions: SD15_RESOLUTIONS,
  quality: QUALITY_PRESETS,
  lora: { anchorNodeId: '4', modelSlot: 0, clipSlot: 1, maxLoras: 8 },
};

export const img2imgSdGenericUnknownManifest: WorkflowManifest = {
  id: 'img2img-sd-generic-unknown',
  version: 1,
  label: 'Image to image (generic, unrecognised model)',
  capability: 'img2img',
  baseModels: [],
  isFallback: true,
  appliesToUnknownFamily: true,
  requiredNodeClasses: IMG2IMG_NODE_CLASSES,
  outputNodeId: '9',
  inputs: IMG2IMG_INPUTS,
  resolutions: GENERIC_SD_RESOLUTIONS,
  quality: QUALITY_PRESETS,
  lora: { anchorNodeId: '4', modelSlot: 0, clipSlot: 1, maxLoras: 8 },
};

// ---------------------------------------------------------------- templates

export const txt2imgSdGenericTemplate: WorkflowTemplate = {
  manifest: txt2imgSdGenericManifest,
  graph: txt2imgSdGenericGraph,
};

export const txt2imgSdGenericUnknownTemplate: WorkflowTemplate = {
  manifest: txt2imgSdGenericUnknownManifest,
  graph: txt2imgSdGenericGraph,
};

export const img2imgSdGenericTemplate: WorkflowTemplate = {
  manifest: img2imgSdGenericManifest,
  graph: img2imgSdGenericGraph,
};

export const img2imgSdGenericUnknownTemplate: WorkflowTemplate = {
  manifest: img2imgSdGenericUnknownManifest,
  graph: img2imgSdGenericGraph,
};

/** Every generic template, in registration order. */
export const SD_GENERIC_TEMPLATES: readonly WorkflowTemplate[] = [
  txt2imgSdGenericTemplate,
  txt2imgSdGenericUnknownTemplate,
  img2imgSdGenericTemplate,
  img2imgSdGenericUnknownTemplate,
];
