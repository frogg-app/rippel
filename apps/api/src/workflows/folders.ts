/**
 * Which ComfyUI model folder each loader node reads, and what that tells us
 * about a template and about a file.
 *
 * Straight out of ComfyUI's `folder_paths`: this is the mapping that decides
 * whether a file on disk is visible to a given node. It used to live inside
 * `models/runnability.ts`; it moved here because the registry now needs the
 * same table to tell two templates for one family apart — the one that loads
 * an LTX-Video file from `checkpoints/` and the one that loads it from
 * `diffusion_models/` are different graphs for the same weights, and which
 * one to run depends on where the operator put the file.
 *
 * Anything not listed is left unchecked rather than guessed at — an unknown
 * loader produces no verdict, not a wrong one.
 */

import { comboOptions, type ObjectInfo } from '../lib/comfy.js';
import { parseInputPath } from './paths.js';
import type { WorkflowTemplate } from './types.js';

export const FOLDER_READ_BY: Readonly<Record<string, string>> = {
  CheckpointLoaderSimple: 'checkpoints',
  CheckpointLoader: 'checkpoints',
  ImageOnlyCheckpointLoader: 'checkpoints',
  UNETLoader: 'diffusion_models',
  UnetLoaderGGUF: 'diffusion_models',
  UnetLoaderGGUFAdvanced: 'diffusion_models',
  LoraLoader: 'loras',
  LoraLoaderModelOnly: 'loras',
  VAELoader: 'vae',
  CLIPLoader: 'text_encoders',
  DualCLIPLoader: 'text_encoders',
  TripleCLIPLoader: 'text_encoders',
  QuadrupleCLIPLoader: 'text_encoders',
  CLIPLoaderGGUF: 'text_encoders',
  DualCLIPLoaderGGUF: 'text_encoders',
  TripleCLIPLoaderGGUF: 'text_encoders',
  QuadrupleCLIPLoaderGGUF: 'text_encoders',
  ControlNetLoader: 'controlnet',
  DiffControlNetLoader: 'controlnet',
  UpscaleModelLoader: 'upscale_models',
  CLIPVisionLoader: 'clip_vision',
};

/** Where a template expects the checkpoint, resolved from its manifest. */
export interface CheckpointSlot {
  nodeId: string;
  input: string;
  nodeClass: string;
  /** The folder that loader reads, or null for a loader we do not know. */
  folder: string | null;
}

export function checkpointSlotOf(template: WorkflowTemplate): CheckpointSlot | null {
  const binding = template.manifest.inputs.find((input) => input.source === 'checkpointFilename');
  if (!binding) return null;
  const parsed = parseInputPath(binding.path);
  if (!parsed) return null;
  const nodeClass = template.graph[parsed.nodeId]?.class_type;
  if (!nodeClass) return null;
  return {
    nodeId: parsed.nodeId,
    input: parsed.inputName,
    nodeClass,
    folder: FOLDER_READ_BY[nodeClass] ?? null,
  };
}

/** The folder the template's *model* loader reads — its checkpoint slot. */
export function loaderFolderOf(template: WorkflowTemplate): string | null {
  return checkpointSlotOf(template)?.folder ?? null;
}

/**
 * Every model folder the graph reads, in graph order and without repeats:
 * `["diffusion_models", "text_encoders", "vae"]` for the UNETLoader LTX graph.
 * What the templates browser shows, so an operator can see at a glance where
 * each file a graph needs has to live.
 */
export function loaderFoldersOf(template: WorkflowTemplate): string[] {
  const out: string[] = [];
  for (const node of Object.values(template.graph)) {
    const folder = FOLDER_READ_BY[node.class_type];
    if (folder && !out.includes(folder)) out.push(folder);
  }
  return out;
}

/** Last path segment, either separator: the backend may be a Windows box. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Which folder a file already on a backend is actually in, read off
 * `/object_info`: the loader whose file combo lists the basename is the one
 * that can see it, and the table above says which folder that loader reads.
 *
 * This is the fact the wrong-folder verdict exists to establish, and it used
 * to be left as "unknown" for installed models because a row's `type` comes
 * from *which loader reported it* — UNETLoader reports a diffusion_models file
 * as a checkpoint. Asking `/object_info` directly answers it properly.
 *
 * Returns null when no known loader lists the file (or without object_info).
 */
export function folderOfInstalled(info: ObjectInfo | null, filename: string): string | null {
  return foldersOfInstalled(info, filename)[0] ?? null;
}

/**
 * Every folder whose loader lists this file, in FOLDER_READ_BY order.
 *
 * The same weights are often in two places — a checkpoint copied into
 * diffusion_models for a UNET graph, say — and judging the file by whichever
 * loader happens to be listed first told people to move a file that was
 * already exactly where the workflow reads it.
 */
export function foldersOfInstalled(info: ObjectInfo | null, filename: string): string[] {
  if (!info) return [];
  const target = basename(filename).toLowerCase();
  const found: string[] = [];
  for (const [nodeClass, folder] of Object.entries(FOLDER_READ_BY)) {
    if (found.includes(folder)) continue;
    const spec = info[nodeClass];
    if (!spec?.input) continue;
    const inputs = { ...(spec.input.required ?? {}), ...(spec.input.optional ?? {}) };
    for (const declared of Object.values(inputs)) {
      const options = comboOptions(declared);
      if (options?.some((option) => basename(option).toLowerCase() === target)) {
        found.push(folder);
        break;
      }
    }
  }
  return found;
}

/** Installer defaults use the same loader table as preflight and verdicts.
 * Wan and Hunyuan encoders are CLIPLoader/DualCLIPLoader types, not folders. */
const DEFAULT_LOADER: Readonly<Record<string, string>> = {
  checkpoint: 'CheckpointLoaderSimple', lora: 'LoraLoader', vae: 'VAELoader',
  controlnet: 'ControlNetLoader', upscaler: 'UpscaleModelLoader', clip: 'CLIPLoader',
};
export function folderForType(type: string): string | null {
  return FOLDER_READ_BY[DEFAULT_LOADER[type] ?? ''] ?? null;
}

/**
 * Folder names older ComfyUI-Manager rows still use, and what ComfyUI calls
 * them now. ComfyUI reads both, but every loader in FOLDER_READ_BY lists the
 * new name, and `/api/models/unet` is a 404 on a stock install.
 */
const LEGACY_FOLDER: Readonly<Record<string, string>> = {
  unet: 'diffusion_models',
  clip: 'text_encoders',
};

/**
 * The one answer to "which model folder does this file belong in?".
 *
 * There used to be three — the catalogue verdict, the install request and the
 * agent's download path each normalised a save path their own way, and they
 * disagreed on `clip`, on `unet` and on an empty save path. A text encoder
 * listed as `clip/` was then judged "wrong folder" against the loader's
 * `text_encoders`, and a `unet/` install landed somewhere `/api/models` could
 * not confirm. Everything that names a folder now asks here.
 *
 * Returns the first segment of `savePath` with legacy names mapped, or the
 * type's own folder when the save path is empty or `default`.
 */
export function canonicalFolder(savePath: string | null | undefined, type: string): string | null {
  return canonicalModelDir(savePath, type)?.split('/')[0] ?? null;
}

/**
 * The whole directory, subfolders kept — `loras/ltxv/ltx2` stays as it is,
 * `unet/flux` becomes `diffusion_models/flux` — for the paths the agent writes.
 */
export function canonicalModelDir(savePath: string | null | undefined, type: string): string | null {
  const segments = (savePath ?? '').split(/[\\/]/).map((seg) => seg.trim()).filter((seg) => seg && seg !== '.');
  if (segments.length === 0 || segments[0] === 'default') return folderForType(type);
  const first = segments[0]!.toLowerCase();
  segments[0] = LEGACY_FOLDER[first] ?? segments[0]!;
  return segments.join('/');
}
