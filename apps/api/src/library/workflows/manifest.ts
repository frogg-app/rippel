/** Infer controls from graph connections and known node semantics. A title is
 * never evidence. Ambiguous controls stay fixed and are returned as omissions. */
import type { JobKind, ModelType } from '@comfy/shared';
import type { ManifestInput, ModelRequirement, ParamConstraint, ParamSource, PresetTable, ResolutionTable, WorkflowManifest } from '../../workflows/types.js';
import { FOLDER_READ_BY } from '../../workflows/folders.js';
import { pruneUnreachable, type ConversionResult, type ConversionSpecs } from './convert.js';
import type { LibraryEntry } from './catalogue.js';

export interface WorkflowFile {
  name: string; url: string; directory: string; paths: string[];
  sha256?: string; sizeBytes?: number;
}
export interface ManifestMapping {
  manifest: WorkflowManifest | null;
  files: WorkflowFile[];
  omitted: string[];
}
const MODEL_TYPES: Record<string, ModelType> = {
  checkpoints: 'checkpoint', diffusion_models: 'checkpoint', text_encoders: 'clip',
  vae: 'vae', loras: 'lora', controlnet: 'controlnet', upscale_models: 'upscaler',
};
const SAMPLING: Record<string, Record<string, ParamSource>> = {
  KSampler: { seed: 'seed', steps: 'steps', cfg: 'guidance', sampler_name: 'sampler', scheduler: 'scheduler' },
  KSamplerAdvanced: { noise_seed: 'seed', steps: 'steps', cfg: 'guidance', sampler_name: 'sampler', scheduler: 'scheduler' },
  RandomNoise: { noise_seed: 'seed' }, BasicScheduler: { steps: 'steps', scheduler: 'scheduler' },
  KSamplerSelect: { sampler_name: 'sampler' }, FluxGuidance: { guidance: 'guidance' },
};
const LATENTS = new Set(['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLTXVLatentVideo', 'EmptyHunyuanLatentVideo', 'Wan22ImageToVideoLatent', 'WanImageToVideo', 'LTXVImgToVideo', 'SVD_img2vid_Conditioning',
  'MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo', 'EmptyMiniMaxH3LatentAV']);
/**
 * Where the prompt goes, for nodes that take it themselves rather than through
 * CLIPTextEncode. A node not listed still counts when it turns one STRING input
 * named like a prompt into CONDITIONING (`textInputOf`).
 */
const PROMPT_INPUTS: Record<string, string> = {
  CLIPTextEncode: 'text', MiniMaxH3ImageToVideo: 'prompt', MiniMaxH3ReferenceToVideo: 'prompt',
  TextEncodeQwenImageEdit: 'prompt', TextEncodeQwenImageEditPlus: 'prompt', TextEncodeHunyuanVideo_ImageToVideo: 'prompt',
};
const PROMPT_NAMES = ['text', 'prompt', 'positive', 'positive_prompt'];
/** Size-node inputs by name; the first group present wins. */
const SIZE_INPUTS: Record<string, ParamSource> = {
  width: 'width', height: 'height', length: 'frameCount', video_frames: 'frameCount', num_frames: 'frameCount',
  frames: 'frameCount', frame_count: 'frameCount', batch_size: 'batchSize',
};
const FPS_INPUTS: Record<string, string> = { CreateVideo: 'fps', SaveWEBM: 'fps', LTXVConditioning: 'frame_rate', SVD_img2vid_Conditioning: 'fps' };
/** Frames a family samples in steps of, counted from frame 1. MiniMax H3's
 * nodes snap the length onto its own 17k+5 grid, so rippel does not. */
const FRAME_QUANTUM: [RegExp, number][] = [[/^Wan/, 4], [/LTXV/, 8]];
/**
 * Nodes that turn an aspect choice into width and height. rippel picks the
 * aspect itself, so the picker is replaced by the sizes it would give for each
 * of rippel's aspects it offers (`pickerResolutions`).
 */
const PICKERS: Record<string, { aspect: string; megapixels: string; multiple?: string }> = {
  ResolutionSelector: { aspect: 'aspect_ratio', megapixels: 'megapixels', multiple: 'multiple' },
};
/** Arithmetic between a control and its node: rippel writes the value instead. */
const COMPUTED = /^ComfyMathExpression$|Math|Expression/;
const ASPECTS = ['1:1', '3:2', '2:3', '16:9', '9:16'] as const;
const SAVE = new Set(['SaveImage', 'SaveVideo', 'SaveWEBM']);
const LOADERS = new Set(['UNETLoader', 'CheckpointLoaderSimple', 'ImageOnlyCheckpointLoader', 'UnetLoaderGGUF']);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function mapManifest(converted: ConversionResult, specs: ConversionSpecs, entry: LibraryEntry,
  options: { id: string; capability: JobKind; family: string }): ManifestMapping {
  const { graph } = converted;
  const omitted = [...converted.issues, ...converted.missingNodes.map((name) => `Missing node: ${name}`)];
  const inputs: ManifestInput[] = [];
  const files: WorkflowFile[] = [];
  const requirements: ModelRequirement[] = [];
  const video = options.capability === 'img2vid' || options.capability === 'txt2vid';
  const linkedId = (value: unknown) => Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;

  function constraint(id: string, name: string, source: ParamSource): ParamConstraint | undefined {
    const spec = specs[graph[id]!.class_type];
    const desc = spec?.input?.required?.[name] ?? spec?.input?.optional?.[name];
    if (!Array.isArray(desc)) return;
    const [type, range = {}] = desc as [unknown, Record<string, unknown>];
    if (Array.isArray(type) && type.every((v) => typeof v === 'string')) return { kind: 'enum', values: type };
    if (type === 'COMBO' && Array.isArray(range.options)) return { kind: 'enum', values: range.options as string[] };
    if (type !== 'INT' && type !== 'FLOAT') return;
    let min = Number(range.min ?? 0), max = Math.min(Number(range.max ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    // A node whose own default is longer (MiniMax H3: 124) keeps that length.
    if (source === 'frameCount') { min = Math.max(min, 5); max = Math.min(max, Math.max(121, Number(range.default ?? 0))); }
    if (source === 'fps') { min = Math.max(min, 1); max = Math.min(max, 30); }
    if (source === 'steps') { min = Math.max(min, 4); max = Math.min(max, 60); }
    if (source === 'batchSize') { min = 1; max = 1; }
    // Frame quantum is relative to frame 1; the compiler's step constraint is
    // a multiple-of rule, so quantum is declared on the manifest separately.
    return source === 'fps' || type === 'INT'
      ? { kind: 'int', min, max, step: source === 'frameCount' ? 1 : Number(range.step ?? 1) }
      : { kind: 'float', min, max };
  }
  /**
   * Bind a control where its value really lives: on the node itself, on the
   * primitive node wired into it (MiniMax H3's prompt and step count), or, for
   * a number computed from other widgets (its length is seconds × 24 in a math
   * node), on the node itself with the computation cut out.
   */
  function bind(id: string, name: string, source: ParamSource, required = true) {
    let value = graph[id]?.inputs[name];
    let target = id, targetName = name;
    if (Array.isArray(value)) {
      const from = graph[value[0]];
      if (from && /^Primitive/.test(from.class_type) && 'value' in from.inputs && !Array.isArray(from.inputs.value)) {
        target = value[0]; targetName = 'value'; value = from.inputs.value;
      } else if (from && COMPUTED.test(from.class_type) && source !== 'prompt' && source !== 'negativePrompt') {
        const fallback = defaultOf(id, name);
        if (fallback !== undefined) { (graph[id]!.inputs as Record<string, unknown>)[name] = fallback; value = fallback; }
      }
    }
    if (value === undefined || Array.isArray(value)) { omitted.push(`${source}: ${id}.${name} is not an editable literal.`); return; }
    const path = `${target}.inputs.${targetName}`;
    // The range is the consuming node's: a primitive accepts any number.
    if (!inputs.some((input) => input.path === path)) inputs.push({ path, source, label: source, required, constraint: constraint(id, name, source) });
  }
  function defaultOf(id: string, name: string): number | undefined {
    const spec = specs[graph[id]!.class_type];
    const desc = spec?.input?.required?.[name] ?? spec?.input?.optional?.[name];
    const value = Array.isArray(desc) ? (desc[1] as { default?: unknown } | undefined)?.default : undefined;
    return typeof value === 'number' ? value : undefined;
  }

  function textInputOf(id: string): string | null {
    const node = graph[id]!;
    if (PROMPT_INPUTS[node.class_type]) return PROMPT_INPUTS[node.class_type]!;
    const spec = specs[node.class_type];
    if (!spec?.output?.includes('CONDITIONING')) return null;
    const declared = { ...spec.input?.required, ...spec.input?.optional };
    const names = PROMPT_NAMES.filter((name) => Array.isArray(declared[name]) && (declared[name] as unknown[])[0] === 'STRING');
    return names.length === 1 ? names[0]! : null;
  }
  function promptNode(id: string | null, role: 'positive' | 'negative', seen = new Set<string>()): string | null {
    if (!id || seen.has(id) || !graph[id]) return null;
    seen.add(id);
    const node = graph[id]!;
    if (textInputOf(id)) return id;
    const next = linkedId(node.inputs[role]) ?? linkedId(node.inputs.conditioning);
    return promptNode(next, role, seen);
  }
  const positive = new Set<string>(), negative = new Set<string>();
  for (const [id, node] of Object.entries(graph)) {
    if (['KSampler', 'KSamplerAdvanced', 'BasicGuider', 'CFGGuider', 'SamplerCustom'].includes(node.class_type)) {
      const p = promptNode(linkedId(node.inputs.positive) ?? linkedId(node.inputs.conditioning), 'positive');
      const n = promptNode(linkedId(node.inputs.negative), 'negative');
      if (p) positive.add(p); if (n) negative.add(n);
    }
    for (const [name, source] of Object.entries(SAMPLING[node.class_type] ?? {})) {
      // Multiple-stage schedules can intentionally differ. Do not unify them.
      const owners = Object.values(graph).filter((candidate) => SAMPLING[candidate.class_type]?.[name] === source);
      if (owners.length > 1) omitted.push(`${source}: several sampling stages; values kept fixed.`);
      else bind(id, name, source);
    }
    if (FPS_INPUTS[node.class_type]) bind(id, FPS_INPUTS[node.class_type]!, 'fps');
  }
  if (positive.size === 1) bind([...positive][0]!, textInputOf([...positive][0]!)!, 'prompt');
  else omitted.push('prompt: no unambiguous positive text conditioning.');
  if (negative.size === 1) bind([...negative][0]!, textInputOf([...negative][0]!)!, 'negativePrompt', false);
  else if (negative.size > 1) omitted.push('negativePrompt: ambiguous negative conditioning.');

  // Known latent makers, or any node that makes a LATENT from width and height.
  const latentNodes = Object.entries(graph).filter(([, node]) => LATENTS.has(node.class_type) ||
    (specs[node.class_type]?.output?.includes('LATENT') && 'width' in node.inputs && 'height' in node.inputs));
  let pickerTable: ResolutionTable | null = null;
  if (latentNodes.length === 1) {
    const [id, node] = latentNodes[0]!;
    pickerTable = detachPicker(id);
    let frames = false;
    for (const [name, source] of Object.entries(SIZE_INPUTS)) {
      if (!(name in node.inputs) || (source === 'frameCount' && frames)) continue;
      if (source === 'frameCount') frames = true;
      bind(id, name, source);
    }
  } else omitted.push('dimensions: no unambiguous latent size control.');
  // A picker or computation cut out above is now beside the graph.
  pruneUnreachable(converted, specs);

  /** When width and height come from one aspect picker, write the sizes it
   * would give straight into the node, and return them per rippel aspect. */
  function detachPicker(id: string): ResolutionTable | null {
    const node = graph[id]!;
    const w = node.inputs.width, h = node.inputs.height;
    if (!Array.isArray(w) || !Array.isArray(h) || w[0] !== h[0] || w[1] !== 0 || h[1] !== 1) return null;
    const picker = graph[w[0]];
    const names = picker && PICKERS[picker.class_type];
    if (!picker || !names) return null;
    const megapixels = Number(picker.inputs[names.megapixels]);
    const multiple = names.multiple ? Number(picker.inputs[names.multiple]) : 8;
    if (!(megapixels > 0) || !(multiple > 0)) return null;
    const spec = specs[picker.class_type];
    const desc = spec?.input?.required?.[names.aspect] ?? spec?.input?.optional?.[names.aspect];
    const [type, options = {}] = Array.isArray(desc) ? desc as [unknown, Record<string, unknown>] : [];
    const allowed = (Array.isArray(type) ? type : type === 'COMBO' && Array.isArray(options.options) ? options.options : []).map(String);
    // Same arithmetic as the picker: total pixels at that aspect, to the multiple.
    const size = (ratio: string) => {
      const [x, y] = ratio.split(':').map(Number);
      const area = megapixels * 1024 * 1024;
      return { width: Math.round(Math.sqrt(area * x! / y!) / multiple) * multiple, height: Math.round(Math.sqrt(area * y! / x!) / multiple) * multiple };
    };
    const offered = ASPECTS.filter((aspect) => allowed.some((value) => value.split(/\s/)[0] === aspect));
    const current = /^(\d+:\d+)/.exec(String(picker.inputs[names.aspect]))?.[1];
    if (!offered.length || !current) return null;
    Object.assign(node.inputs, size(current));
    return Object.fromEntries(offered.map((aspect) => [aspect, size(aspect)])) as unknown as ResolutionTable;
  }

  const loaderNodes = Object.entries(graph).filter(([, node]) => LOADERS.has(node.class_type));
  let mainPath: string | null = null;
  if (loaderNodes.length === 1) {
    const [id, node] = loaderNodes[0]!;
    const name = 'unet_name' in node.inputs ? 'unet_name' : 'ckpt_name';
    mainPath = `${id}.inputs.${name}`;
    inputs.push({ path: mainPath, source: 'checkpointFilename', label: 'Model', required: true, constraint: { kind: 'model', modelType: 'checkpoint' } });
  } else omitted.push('model: several or no primary model loaders.');

  for (const [id, editorNode] of Object.entries(converted.nodes)) {
    const models = editorNode.properties.models;
    if (!Array.isArray(models)) continue;
    for (const raw of models) {
      if (!raw || typeof raw !== 'object') continue;
      const file = raw as { name?: string; url?: string; directory?: string };
      if (!file.name || !file.url || !file.directory) { omitted.push(`model files: incomplete metadata on ${id}.`); continue; }
      const folder = FOLDER_READ_BY[editorNode.type];
      if (!folder || file.directory !== folder) { omitted.push(`model files: unrecognized folder for ${id}.`); continue; }
      const paths = Object.entries(graph[id]!.inputs).filter(([, value]) => value === file.name).map(([name]) => `${id}.inputs.${name}`);
      if (!paths.length) { omitted.push(`model files: ${file.name} has no matching loader input.`); continue; }
      const existing = files.find((value) => value.name === file.name && value.directory === file.directory);
      if (existing) existing.paths.push(...paths); else files.push({ name: file.name, url: file.url, directory: file.directory, paths });
      for (const path of paths.filter((path) => path !== mainPath)) requirements.push({
        id: `file-${requirements.length}`, path, modelType: MODEL_TYPES[folder] ?? 'checkpoint', label: file.name,
        why: `Required by ${entry.title}.`, match: { filename: new RegExp(`(?:^|[\\\\/])${escape(file.name)}$`, 'i') }, preferred: [file.name],
      });
    }
  }

  const saved = Object.entries(graph).filter(([, node]) => SAVE.has(node.class_type));
  const ioOutputs = entry.io?.outputs.map((output) => String(output.nodeId)) ?? [];
  const named = saved.filter(([id]) => ioOutputs.includes(id));
  const output = named.length === 1 ? named[0] : saved.length === 1 ? saved[0] : undefined;
  if (!output) omitted.push('output: no unambiguous save node.');
  else bind(output[0], 'filename_prefix', 'filenamePrefix', false);

  const imageIds = entry.io?.inputs.filter((input) => input.nodeType === 'LoadImage').map((input) => String(input.nodeId)) ?? [];
  const imageNodes = imageIds.filter((id) => graph[id]?.class_type === 'LoadImage');
  const initImageNodeId = imageNodes.length === 1 ? imageNodes[0] : undefined;
  if (['img2vid', 'img2img'].includes(options.capability) && !initImageNodeId) omitted.push('first frame: catalogue does not identify one enabled LoadImage.');

  // Build presets from values already in the official graph. Only mapped
  // controls can change; otherwise preserve the authored workflow unchanged.
  function valueFor(source: ParamSource, fallback: number | string) {
    const input = inputs.find((input) => input.source === source);
    if (!input) return fallback;
    const [id, , name] = input.path.split('.');
    return graph[id!]!.inputs[name!] as number | string;
  }
  const base = { steps: Number(valueFor('steps', 20)), cfg: Number(valueFor('guidance', 5)), sampler: String(valueFor('sampler', 'euler')), scheduler: String(valueFor('scheduler', 'simple')) };
  const quality: PresetTable = { fast: { ...base, steps: Math.max(4, Math.min(base.steps, 8)) }, balanced: base, high: base };
  const widthInput = inputs.find((input) => input.source === 'width');
  const heightInput = inputs.find((input) => input.source === 'height');
  const widthRange = widthInput?.constraint;
  const heightRange = heightInput?.constraint;
  const grid = Math.max(widthRange?.kind === 'int' ? widthRange.step ?? 1 : 8,
    heightRange?.kind === 'int' ? heightRange.step ?? 1 : 8);
  const area = Math.min(Number(valueFor('width', 512)) * Number(valueFor('height', 512)), video ? 512 * 512 : 1024 * 1024);
  const resolutions = pickerTable ?? Object.fromEntries(ASPECTS.map((aspect) => {
    const [x, y] = aspect.split(':').map(Number);
    return [aspect, { width: Math.round(Math.sqrt(area * x! / y!) / grid) * grid,
      height: Math.round(Math.sqrt(area * y! / x!) / grid) * grid }];
  })) as unknown as ResolutionTable;
  const latentType = latentNodes[0]?.[1].class_type ?? '';
  const quantum = FRAME_QUANTUM.find(([pattern]) => pattern.test(latentType))?.[1] ?? 1;
  const requiredSources: ParamSource[] = ['prompt', 'checkpointFilename', 'width', 'height', ...(video ? ['frameCount', 'fps'] as const : [])];
  const absent = requiredSources.filter((source) => !inputs.some((input) => input.source === source));
  omitted.push(...absent.map((source) => `${source}: required control unavailable.`));
  const unsupported = converted.issues.length || converted.missingNodes.length || absent.length || !output ||
    (['img2vid', 'img2img'].includes(options.capability) && !initImageNodeId);
  return { files, omitted: [...new Set(omitted)], manifest: unsupported ? null : {
    id: options.id, version: 1, label: entry.title, capability: options.capability, baseModels: [options.family],
    inputs, requires: requirements, requiredNodeClasses: [...new Set(Object.values(graph).map((node) => node.class_type))],
    outputNodeId: output![0], initImageNodeId, frameQuantum: video ? quantum : undefined, quality, resolutions,
  } };
}
