/**
 * Public surface of the workflow-template layer.
 *
 * The compiler, the routes and the orchestrator import from here; nothing
 * outside this directory should reach into an individual template module.
 */

export type {
  ComfyApiGraph,
  ComfyApiNode,
  ManifestInput,
  NodeInputValue,
  NodeLink,
  ParamConstraint,
  ParamSource,
  PresetDefaults,
  PresetTable,
  Resolution,
  ResolutionTable,
  WidgetValue,
  WorkflowManifest,
  WorkflowTemplate,
} from './types.js';

export {
  GENERIC_SD_RESOLUTIONS,
  SD15_RESOLUTIONS,
  LTXV_FRAME_QUANTUM,
  LTXV_MAX_FPS,
  LTXV_MAX_FRAMES,
  LTXV_MIN_FPS,
  LTXV_MIN_FRAMES,
  LTXV_NATIVE_FPS,
  LTXV_QUALITY_PRESETS,
  LTXV_RESOLUTIONS,
  LTXV_SAMPLERS,
  MAX_SEED,
  QUALITY_PRESETS,
  SDXL_RESOLUTIONS,
  SDXL_SAMPLERS,
  SDXL_SCHEDULERS,
  presetFor,
  resolutionFor,
} from './presets.js';

export { isNodeLink, parseInputPath, resolveInputPath } from './paths.js';

export type { CapabilityOffer, TemplateIndex } from './registry.js';
export {
  TEMPLATES,
  allManifests,
  buildTemplateIndex,
  capabilitiesFor,
  capabilityOffersFor,
  findTemplate,
  findTemplateById,
  normalizeBaseModel,
  resolveTemplate,
} from './registry.js';

/**
 * The generic Stable-Diffusion fallback. Exported so the API can name the
 * templates it is falling back to, and so tests can assert the exclusion list is
 * the one being enforced.
 */
export {
  NON_SD_NODE_SET_FAMILIES,
  SD_GENERIC_TEMPLATES,
  img2imgSdGenericManifest,
  img2imgSdGenericTemplate,
  img2imgSdGenericUnknownManifest,
  img2imgSdGenericUnknownTemplate,
  txt2imgSdGenericManifest,
  txt2imgSdGenericTemplate,
  txt2imgSdGenericUnknownManifest,
  txt2imgSdGenericUnknownTemplate,
} from './sd-generic.js';

export { txt2imgSdxlManifest, txt2imgSdxlTemplate } from './txt2img-sdxl.js';

export {
  IMG2IMG_INIT_IMAGE_NODE_ID,
  img2imgSdxlManifest,
  img2imgSdxlTemplate,
} from './img2img-sdxl.js';

export {
  LTXV_BASE_MODELS,
  txt2vidLtxvManifest,
  txt2vidLtxvTemplate,
} from './txt2vid-ltxv.js';

export {
  IMG2VID_FIRST_FRAME_NODE_ID,
  img2vidLtxvManifest,
  img2vidLtxvTemplate,
} from './img2vid-ltxv.js';

/**
 * The init-image transfer. Exported here because the orchestrator is its only
 * caller: nothing in this directory wires it into a dispatch.
 */
export type { TransferredInitImage } from './init-image.js';
export {
  INIT_IMAGE_SUBFOLDER,
  sendInitImageToBackend,
  sendStoredInitImageToBackend,
  withInitImage,
} from './init-image.js';
