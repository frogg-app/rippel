/**
 * LoRA chaining.
 *
 * ComfyUI has no "list of LoRAs" node: each LoRA is a `LoraLoader` that takes a
 * MODEL and a CLIP and returns a patched MODEL and CLIP, so N LoRAs means N
 * nodes wired nose-to-tail. Templates are authored *without* LoRAs — a template
 * per possible LoRA count would be absurd — so the compiler splices the chain in
 * between the checkpoint loader and everything that consumes it.
 *
 * The rewiring is the delicate part: after splicing, every link that used to
 * read the anchor's MODEL/CLIP must read the *last* loader's instead, or the
 * LoRAs are loaded and silently ignored (a bug that looks like "this LoRA does
 * nothing" and wastes a lot of VRAM proving it).
 */

import { ValidationError } from './errors.js';
import { cloneGraph } from './json-path.js';
import type { MutableComfyGraph, ComfyLink, LoraChainSpec } from './manifest.js';
import { TemplateError } from './errors.js';

/** LoraLoader's outputs, fixed by the node class. */
const LORA_MODEL_SLOT = 0;
const LORA_CLIP_SLOT = 1;

export const LORA_WEIGHT_MIN = -4;
export const LORA_WEIGHT_MAX = 4;
const DEFAULT_MAX_LORAS = 8;

/** A LoraSelection after the model id has been resolved to a real filename. */
export interface ResolvedLora {
  filename: string;
  weight: number;
}

export interface LoraChainResult {
  graph: MutableComfyGraph;
  /** Ids of the nodes we created, in chain order. Useful for tests and logs. */
  nodeIds: string[];
}

function isLink(value: unknown): value is ComfyLink {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

/**
 * Ids ComfyUI accepts are strings, but templates use stringified integers and
 * some tooling assumes that, so we keep counting from the highest integer id
 * rather than inventing `lora_0`. Non-numeric ids in the template are ignored
 * for the max but still checked for collisions.
 */
function nextIdAllocator(graph: MutableComfyGraph): () => string {
  let next = 0;
  for (const id of Object.keys(graph)) {
    const n = Number(id);
    if (Number.isInteger(n) && n >= next) next = n + 1;
  }
  return () => {
    while (Object.prototype.hasOwnProperty.call(graph, String(next))) next += 1;
    const id = String(next);
    next += 1;
    return id;
  };
}

export function applyLoraChain(
  graph: MutableComfyGraph,
  spec: LoraChainSpec,
  loras: readonly ResolvedLora[],
): LoraChainResult {
  if (loras.length === 0) return { graph, nodeIds: [] };

  const max = spec.maxLoras ?? DEFAULT_MAX_LORAS;
  if (loras.length > max) {
    throw new ValidationError('loras', `At most ${max} LoRAs may be used at once (got ${loras.length})`);
  }
  loras.forEach((lora, i) => {
    if (typeof lora.weight !== 'number' || !Number.isFinite(lora.weight)) {
      throw new ValidationError(`loras[${i}].weight`, 'LoRA weight must be a number');
    }
    if (lora.weight < LORA_WEIGHT_MIN || lora.weight > LORA_WEIGHT_MAX) {
      throw new ValidationError(
        `loras[${i}].weight`,
        `LoRA weight must be between ${LORA_WEIGHT_MIN} and ${LORA_WEIGHT_MAX} (got ${lora.weight})`,
      );
    }
    if (typeof lora.filename !== 'string' || lora.filename.length === 0) {
      throw new ValidationError(`loras[${i}]`, 'LoRA has no resolved filename');
    }
  });

  const next = cloneGraph(graph);
  if (!Object.prototype.hasOwnProperty.call(next, spec.anchorNodeId)) {
    throw new TemplateError(
      `LoRA anchor node "${spec.anchorNodeId}" does not exist in the template`,
    );
  }

  const allocate = nextIdAllocator(next);
  const nodeClass = spec.nodeClass ?? 'LoraLoader';
  const nodeIds: string[] = [];

  // Build the chain first, each loader reading from the previous one. The head
  // reads from the anchor; nothing else is touched yet.
  let modelSource: ComfyLink = [spec.anchorNodeId, spec.modelSlot];
  let clipSource: ComfyLink = [spec.anchorNodeId, spec.clipSlot];

  for (const lora of loras) {
    const id = allocate();
    next[id] = {
      class_type: nodeClass,
      inputs: {
        lora_name: lora.filename,
        // ComfyUI keeps model and clip strengths separate. We expose one weight
        // in the UI because two sliders per LoRA is a worse product; sending the
        // same number to both is what every front-end does.
        strength_model: lora.weight,
        strength_clip: lora.weight,
        model: modelSource,
        clip: clipSource,
      },
      _meta: { title: `LoRA: ${lora.filename}` },
    };
    modelSource = [id, LORA_MODEL_SLOT];
    clipSource = [id, LORA_CLIP_SLOT];
    nodeIds.push(id);
  }

  // Now redirect the former consumers of the anchor onto the chain's tail.
  // Skipping our own nodes is what stops the chain from eating its own head.
  const created = new Set(nodeIds);
  for (const [id, node] of Object.entries(next)) {
    if (created.has(id)) continue;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!isLink(value)) continue;
      if (value[0] !== spec.anchorNodeId) continue;
      if (value[1] === spec.modelSlot) node.inputs[key] = [...modelSource] as ComfyLink;
      else if (value[1] === spec.clipSlot) node.inputs[key] = [...clipSource] as ComfyLink;
      // Other slots (VAE, for instance) are left alone: LoraLoader does not
      // produce them, so rerouting them would break the graph.
    }
  }

  return { graph: next, nodeIds };
}
