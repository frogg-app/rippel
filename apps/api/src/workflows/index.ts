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
  MAX_SEED,
  QUALITY_PRESETS,
  SDXL_RESOLUTIONS,
  SDXL_SAMPLERS,
  SDXL_SCHEDULERS,
  presetFor,
  resolutionFor,
} from './presets.js';

export { isNodeLink, parseInputPath, resolveInputPath } from './paths.js';

export {
  TEMPLATES,
  allManifests,
  capabilitiesFor,
  findTemplate,
  findTemplateById,
  normalizeBaseModel,
} from './registry.js';

export { txt2imgSdxlManifest, txt2imgSdxlTemplate } from './txt2img-sdxl.js';
