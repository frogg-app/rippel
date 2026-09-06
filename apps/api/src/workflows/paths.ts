/**
 * Manifest path parsing.
 *
 * Manifest paths are deliberately a tiny, fixed grammar — `<nodeId>.inputs.
 * <inputName>` — rather than general JSONPath. A general query language would
 * let a manifest reach anywhere in the graph, including `class_type` or another
 * node's link tuple, which is precisely the class of edit we never want a
 * user-facing parameter to be able to make. Restricting the grammar means the
 * worst a malformed manifest can do is fail validation at startup.
 *
 * This module is read-only on purpose: it locates and inspects. Writing values
 * is the compiler's job.
 */

import type { ComfyApiGraph, NodeInputValue } from './types.js';

export interface ParsedPath {
  readonly nodeId: string;
  readonly inputName: string;
}

/** Node ids are strings, but ComfyUI's own are numeric and ours should be too. */
const PATH_RE = /^([A-Za-z0-9_-]+)\.inputs\.([A-Za-z0-9_]+)$/;

export function parseInputPath(path: string): ParsedPath | undefined {
  const m = PATH_RE.exec(path);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  return { nodeId: m[1], inputName: m[2] };
}

/**
 * Resolve a manifest path against a graph.
 *
 * Returns `undefined` when the path is malformed, names a node that is not in
 * the graph, or names an input that node does not declare. The last case is the
 * one that matters: ComfyUI silently ignores an unknown key in `inputs`, so a
 * typo like `sampler` for `sampler_name` would leave the hand-authored default
 * in place and produce plausible-but-wrong images forever. The unit tests walk
 * every manifest path through this function for exactly that reason.
 */
export function resolveInputPath(
  graph: ComfyApiGraph,
  path: string,
): NodeInputValue | undefined {
  const parsed = parseInputPath(path);
  if (!parsed) return undefined;
  const node = graph[parsed.nodeId];
  if (!node) return undefined;
  if (!Object.prototype.hasOwnProperty.call(node.inputs, parsed.inputName)) return undefined;
  return node.inputs[parsed.inputName];
}

/** True when a node input value is a link to another node rather than a widget. */
export function isNodeLink(value: NodeInputValue): value is readonly [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number'
  );
}
