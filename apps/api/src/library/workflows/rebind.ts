/** Point an imported workflow's main model loader at a file already installed,
 * instead of the file the official workflow names. Used when a workflow is
 * added *for* a model: that model is the one it should load, and the official
 * file is then neither required nor downloaded. */
import type { ComfyApiGraph } from '../../workflows/types.js';
import type { ManifestMapping } from './manifest.js';

/** False when the workflow has no single main-model input to point anywhere. */
export function rebindCheckpoint(graph: ComfyApiGraph, mapping: ManifestMapping, filename: string): boolean {
  const input = mapping.manifest?.inputs.find((candidate) => candidate.source === 'checkpointFilename');
  if (!input) return false;
  const [nodeId, , name] = input.path.split('.');
  const node = nodeId ? graph[nodeId] : undefined;
  if (!node || !name) return false;
  (node.inputs as Record<string, unknown>)[name] = filename;
  mapping.files = mapping.files
    .map((file) => ({ ...file, paths: file.paths.filter((path) => path !== input.path) }))
    .filter((file) => file.paths.length > 0);
  return true;
}
