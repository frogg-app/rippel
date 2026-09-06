/**
 * The compiler's view of a workflow template + manifest.
 *
 * There is nothing defined here any more: the authored shape in
 * `src/workflows/types.ts` is canonical, and this file re-exports it under the
 * names the compiler uses. It stays as a file rather than being deleted so the
 * seam remains visible — if the two ever have to diverge (a manifest field the
 * compiler must not see, say), this is where the adaptation goes.
 *
 * The design rule both sides already agreed on independently: a manifest never
 * contains graph *edits*, only *addresses* — a path into the API-format graph
 * plus a statement of which user-facing value belongs there and which values
 * are legal. The UI therefore never sees a node, and adding a model family is
 * a data change.
 */

export type {
  ComfyApiGraph as ComfyGraph,
  ComfyApiNode as ComfyNode,
  NodeLink as ComfyLink,
  NodeInputValue as ComfyInputValue,
  LoraChainSpec,
  ManifestInput,
  ParamConstraint as ManifestConstraint,
  ParamSource as ManifestBinding,
  PresetDefaults,
  WorkflowManifest,
  WorkflowTemplate,
} from '../workflows/types.js';

import type { ComfyApiNode, NodeInputValue } from '../workflows/types.js';

/**
 * The same graph, writable.
 *
 * Templates are `readonly` on purpose — one manifest object is shared by every
 * concurrent job and must never be edited in place. The compiler works on a
 * deep clone it owns outright, so it needs a mutable view of the same shape.
 * The clone is the only thing this type is ever applied to.
 */
export type MutableComfyNode = {
  -readonly [K in keyof ComfyApiNode]: K extends 'inputs'
    ? Record<string, NodeInputValue>
    : ComfyApiNode[K];
};

export type MutableComfyGraph = Record<string, MutableComfyNode>;
