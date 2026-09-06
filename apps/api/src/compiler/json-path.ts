/**
 * Dot-separated JSON paths over a ComfyUI API-format graph, e.g.
 * `"6.inputs.text"` or `"10.inputs.noise_seed"`.
 *
 * Two rules drive the whole file:
 *
 *  1. **Never mutate the template.** Templates are module-level constants
 *     loaded once per process; a single in-place write would leak one user's
 *     prompt into the next job compiled from the same template. `setPath`
 *     therefore clones, and `cloneGraph` is the only way a graph is copied.
 *  2. **An unknown path is a hard error.** A silent no-op means a job runs at
 *     the template's default steps or, worse, someone else's baked-in prompt,
 *     and looks successful. A manifest that addresses a node the template no
 *     longer has must fail loudly at compile time.
 */

import { TemplateError } from './errors.js';
import type { MutableComfyGraph } from './manifest.js';

/**
 * Structured clone of a plain JSON value. `structuredClone` is in Node's
 * globals since 17 and handles arrays/objects without the JSON round-trip's
 * cost or its `undefined`-eating surprises.
 */
export function cloneGraph<T>(value: T): T {
  return structuredClone(value);
}

function splitPath(path: string): string[] {
  if (path.length === 0) throw new TemplateError('Empty JSON path');
  const segments = path.split('.');
  if (segments.some((s) => s.length === 0)) {
    throw new TemplateError(`Malformed JSON path "${path}": empty segment`);
  }
  return segments;
}

/**
 * Walk `path` and return the container holding the final key, plus that key.
 * Used by both get and set so they agree exactly on what "exists" means.
 */
function resolveParent(
  root: unknown,
  path: string,
): { parent: Record<string, unknown>; key: string } {
  const segments = splitPath(path);
  let node: unknown = root;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    if (node === null || typeof node !== 'object') {
      throw new TemplateError(
        `JSON path "${path}" cannot be resolved: "${segments.slice(0, i).join('.')}" is not an object`,
      );
    }
    const container = node as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(container, segment)) {
      throw new TemplateError(
        `JSON path "${path}" does not exist in the graph (missing "${segments.slice(0, i + 1).join('.')}")`,
      );
    }
    node = container[segment];
  }

  if (node === null || typeof node !== 'object') {
    throw new TemplateError(`JSON path "${path}" cannot be resolved: parent is not an object`);
  }
  return { parent: node as Record<string, unknown>, key: segments[segments.length - 1] as string };
}

/** Read the value at `path`. Throws if any segment is missing. */
export function getPath(graph: MutableComfyGraph, path: string): unknown {
  const { parent, key } = resolveParent(graph, path);
  if (!Object.prototype.hasOwnProperty.call(parent, key)) {
    throw new TemplateError(`JSON path "${path}" does not exist in the graph`);
  }
  return parent[key];
}

/** True when `path` resolves; useful for manifest linting, never for silent skips. */
export function hasPath(graph: MutableComfyGraph, path: string): boolean {
  try {
    getPath(graph, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a *new* graph with `path` set to `value`. The input graph is left
 * byte-for-byte untouched.
 */
export function setPath(graph: MutableComfyGraph, path: string, value: unknown): MutableComfyGraph {
  const next = cloneGraph(graph);
  setPathInPlace(next, path, value);
  return next;
}

/**
 * In-place variant, for the compiler's own already-cloned working copy. Not
 * exported beyond the compiler: callers outside it should use `setPath` so the
 * no-mutation guarantee is impossible to get wrong.
 */
export function setPathInPlace(graph: MutableComfyGraph, path: string, value: unknown): void {
  const { parent, key } = resolveParent(graph, path);
  if (!Object.prototype.hasOwnProperty.call(parent, key)) {
    throw new TemplateError(`JSON path "${path}" does not exist in the graph`);
  }
  parent[key] = value;
}

/** Apply many substitutions at once, returning one new graph. */
export function setPaths(
  graph: MutableComfyGraph,
  entries: readonly (readonly [path: string, value: unknown])[],
): MutableComfyGraph {
  const next = cloneGraph(graph);
  for (const [path, value] of entries) setPathInPlace(next, path, value);
  return next;
}
