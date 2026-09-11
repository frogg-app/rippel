/** Infer controls from graph connections and known node semantics. A title is
 * never evidence. Ambiguous controls stay fixed and are returned as omissions. */
import type { JobKind, ModelType } from '@comfy/shared';
import type { ManifestInput, ModelRequirement, ParamConstraint, ParamSource, PresetTable, ResolutionTable, WorkflowManifest } from '../../workflows/types.js';
import { FOLDER_READ_BY } from '../../workflows/folders.js';
import type { ConversionResult, ConversionSpecs } from './convert.js';
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
const LATENTS = new Set(['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLTXVLatentVideo', 'EmptyHunyuanLatentVideo', 'Wan22ImageToVideoLatent', 'WanImageToVideo', 'LTXVImgToVideo', 'SVD_img2vid_Conditioning']);
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
    if (source === 'frameCount') { min = Math.max(min, 5); max = Math.min(max, 121); }
    if (source === 'fps') { min = Math.max(min, 1); max = Math.min(max, 30); }
    if (source === 'steps') { min = Math.max(min, 4); max = Math.min(max, 60); }
    if (source === 'batchSize') { min = 1; max = 1; }
    // Frame quantum is relative to frame 1; the compiler's step constraint is
    // a multiple-of rule, so quantum is declared on the manifest separately.
    return source === 'fps' || type === 'INT'
      ? { kind: 'int', min, max, step: source === 'frameCount' ? 1 : Number(range.step ?? 1) }
      : { kind: 'float', min, max };
  }
  function bind(id: string, name: string, source: ParamSource, required = true) {
    const value = graph[id]?.inputs[name];
    if (value === undefined || Array.isArray(value)) { omitted.push(`${source}: ${id}.${name} is not an editable literal.`); return; }
    const path = `${id}.inputs.${name}`;
    if (!inputs.some((input) => input.path === path)) inputs.push({ path, source, label: source, required, constraint: constraint(id, name, source) });
  }

  function promptNode(id: string | null, role: 'positive' | 'negative', seen = new Set<string>()): string | null {
    if (!id || seen.has(id) || !graph[id]) return null;
    seen.add(id);
    const node = graph[id]!;
    if (node.class_type === 'CLIPTextEncode') return id;
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
    if (['CreateVideo', 'SaveWEBM', 'LTXVConditioning', 'SVD_img2vid_Conditioning'].includes(node.class_type)) {
      const name = node.class_type === 'LTXVConditioning' ? 'frame_rate' : 'fps';
      bind(id, name, 'fps');
    }
  }
  if (positive.size === 1) bind([...positive][0]!, 'text', 'prompt');
  else omitted.push('prompt: no unambiguous positive text conditioning.');
  if (negative.size === 1) bind([...negative][0]!, 'text', 'negativePrompt', false);
  else if (negative.size > 1) omitted.push('negativePrompt: ambiguous negative conditioning.');

  const latentNodes = Object.entries(graph).filter(([, node]) => LATENTS.has(node.class_type));
  if (latentNodes.length === 1) {
    const [id, node] = latentNodes[0]!;
    for (const [name, source] of Object.entries({ width: 'width', height: 'height', length: 'frameCount', video_frames: 'frameCount', batch_size: 'batchSize' } as const)) {
      if (name in node.inputs) bind(id, name, source);
    }
  } else omitted.push('dimensions: no unambiguous latent size control.');

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
  const resolutions = Object.fromEntries(['1:1', '3:2', '2:3', '16:9', '9:16'].map((aspect) => {
    const [x, y] = aspect.split(':').map(Number);
    return [aspect, { width: Math.round(Math.sqrt(area * x! / y!) / grid) * grid,
      height: Math.round(Math.sqrt(area * y! / x!) / grid) * grid }];
  })) as unknown as ResolutionTable;
  const quantum = latentNodes[0]?.[1].class_type.startsWith('Wan') ? 4 : latentNodes[0]?.[1].class_type.includes('LTXV') ? 8 : 1;
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
