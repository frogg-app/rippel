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
  ModelRequirement,
  NodeInputValue,
  NodeLink,
  ParamConstraint,
  ParamSource,
  PresetDefaults,
  PresetTable,
  RequirementMatch,
  Resolution,
  ResolutionTable,
  WidgetValue,
  WorkflowManifest,
  WorkflowTemplate,
} from './types.js';

/**
 * Companion-model resolution. The orchestrator calls
 * `withResolvedRequirements` on a compiled graph; the models screen's readiness
 * endpoint calls `resolveRequirements` to say what is missing.
 */
export type { RequirementSite, ResolvedRequirement } from './requirements.js';
export {
  modelBasename,
  rankCandidates,
  requirementSite,
  requirementsOf,
  resolveRequirements,
  sameModelFile,
  withResolvedRequirements,
} from './requirements.js';

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

export { videoLimitsFor } from './limits.js';

export {
  WAN22_TEXT_ENCODER_REQUIREMENT,
  WAN22_TI2V_5B_BASE_MODELS,
  WAN22_TI2V_REQUIREMENTS,
  WAN22_VAE_REQUIREMENT,
  img2vidWan22Ti2v5bManifest,
  img2vidWan22Ti2v5bTemplate,
} from './img2vid-wan22-ti2v-5b.js';

export type { CapabilityOffer, TemplateIndex } from './registry.js';
export {
  TEMPLATES,
  allManifests,
  buildTemplateIndex,
  candidateTemplates,
  capabilitiesFor,
  capabilityOffersFor,
  findTemplate,
  findTemplateById,
  knownCapabilities,
  normalizeBaseModel,
  resolveTemplate,
  templatesFor,
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
  LTXV_REQUIREMENTS,
  LTXV_TEXT_ENCODER_REQUIREMENT,
  txt2vidLtxvManifest,
  txt2vidLtxvTemplate,
} from './txt2vid-ltxv.js';

export {
  IMG2VID_FIRST_FRAME_NODE_ID,
  img2vidLtxvManifest,
  img2vidLtxvTemplate,
} from './img2vid-ltxv.js';

export {
  LTXV_VAE_REQUIREMENT,
  txt2vidLtxvDmManifest,
  txt2vidLtxvDmTemplate,
} from './txt2vid-ltxv-dm.js';
export { img2vidLtxvDmManifest, img2vidLtxvDmTemplate } from './img2vid-ltxv-dm.js';
export {
  HUNYUAN_BASE_MODELS,
  HUNYUAN_REQUIREMENTS,
  txt2vidHunyuanManifest,
  txt2vidHunyuanTemplate,
} from './txt2vid-hunyuan.js';
export {
  FOLDER_READ_BY,
  checkpointSlotOf,
  folderOfInstalled,
  loaderFolderOf,
  loaderFoldersOf,
} from './folders.js';

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
