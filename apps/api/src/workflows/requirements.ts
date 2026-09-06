/**
 * Resolving a template's companion models against a real backend.
 *
 * A `ModelRequirement` (see types.ts) says "this graph needs *a* T5 text
 * encoder, and it goes at 12.inputs.clip_name". This module turns that into
 * "…and on this backend that is `t5/t5xxl_fp8_e4m3fn.safetensors`", by reading
 * the option list ComfyUI reports for that loader's input and picking from it.
 *
 * Why this cannot be done in the compiler, and is not:
 *
 *   The compiler is pure and synchronous — the same params and template give
 *   the same graph on any machine, which is what makes a job reproducible. A
 *   requirement's answer is a property of *one backend at one moment*: install a
 *   T5 and it changes. So this happens where the init-image transfer already
 *   happens — after compiling, against the backend that was claimed, as a graph
 *   rewrite (see `withInitImage` in init-image.ts, which has exactly this
 *   shape and exactly this reason).
 *
 * What happens when nothing matches is deliberate: the graph keeps the literal
 * the template shipped with. That leaves `preflight.ts` to produce its existing,
 * good message naming the missing file, rather than this module inventing a
 * second failure path for the same condition. Resolution improves the graph; it
 * is never the thing that refuses a job.
 */

import { comboOptions, type ObjectInfo } from '../lib/comfy.js';
import { parseInputPath } from './paths.js';
import type {
  ComfyApiGraph,
  ModelRequirement,
  WorkflowManifest,
  WorkflowTemplate,
} from './types.js';

/**
 * Compare two model filenames the way ComfyUI's own resolver effectively does.
 *
 * A backend may report `SDXL\sd_xl_base_1.0.safetensors` (Windows) where our
 * database holds `SDXL/sd_xl_base_1.0.safetensors`, and a separator or a case
 * difference must never read as a different file. This mirrors the private
 * `sameFile` in orchestrator/preflight.ts; it is four lines and lives here too
 * rather than the two modules growing a dependency on each other's internals.
 */
export function sameModelFile(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/** Last path segment, for either separator — the backend may be Windows. */
export function modelBasename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Where in the graph a requirement lands: the node, the input, and — read back
 * out of the graph rather than restated on the requirement — the loader class
 * whose `/object_info` entry lists the candidate files.
 *
 * Returns `undefined` for a path that does not resolve. That is a manifest bug
 * and the unit tests catch it; at runtime it simply means the requirement is
 * skipped rather than throwing during a dispatch.
 */
export interface RequirementSite {
  readonly nodeId: string;
  readonly inputName: string;
  readonly nodeClass: string;
  /** The literal the hand-authored graph ships with, when it has one. */
  readonly literal: string | null;
}

export function requirementSite(
  graph: ComfyApiGraph,
  requirement: ModelRequirement,
): RequirementSite | undefined {
  const parsed = parseInputPath(requirement.path);
  if (!parsed) return undefined;
  const node = graph[parsed.nodeId];
  if (!node) return undefined;
  if (!Object.prototype.hasOwnProperty.call(node.inputs, parsed.inputName)) return undefined;
  const value = node.inputs[parsed.inputName];
  return {
    nodeId: parsed.nodeId,
    inputName: parsed.inputName,
    nodeClass: node.class_type,
    literal: typeof value === 'string' ? value : null,
  };
}

/** What a backend offers for one requirement, and what we would write. */
export interface ResolvedRequirement {
  readonly requirement: ModelRequirement;
  readonly site: RequirementSite;
  /**
   * Every file the backend offers for that loader input. `null` when the input
   * is not a combo at all — the same distinction preflight draws, and for the
   * same reason: an empty list means "nothing installed", `null` means "not a
   * question this input answers".
   */
  readonly available: readonly string[] | null;
  /** Those matching the requirement, best first. */
  readonly candidates: readonly string[];
  /** The one we would write into the graph, or null when nothing matches. */
  readonly filename: string | null;
}

/**
 * Rank the files a backend offers against one requirement.
 *
 * Ordering has to be stable, because the filename ends up recorded on the job:
 * two dispatches of the same job on the same backend must pick the same
 * encoder. Preference order first (by basename, so a subfolder does not defeat
 * it), then shortest name, then alphabetical — the last two only to break ties
 * deterministically, not because a shorter name is better.
 */
export function rankCandidates(
  requirement: ModelRequirement,
  available: readonly string[],
): string[] {
  const pattern = requirement.match.filename;
  const matched = pattern ? available.filter((f) => pattern.test(f)) : [...available];

  const preferred = (requirement.preferred ?? []).map((p) => modelBasename(p).toLowerCase());
  const rank = (f: string): number => {
    const i = preferred.indexOf(modelBasename(f).toLowerCase());
    return i === -1 ? preferred.length : i;
  };

  return matched.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byLength = a.length - b.length;
    if (byLength !== 0) return byLength;
    return a.localeCompare(b);
  });
}

/**
 * Resolve every requirement of a template against one backend's `/object_info`.
 *
 * Pure: the caller supplies the info (from `objectInfoFor`, which owns the
 * fetch and its cache) and decides what to do with the answers.
 */
export function resolveRequirements(
  template: WorkflowTemplate,
  info: ObjectInfo,
): ResolvedRequirement[] {
  const out: ResolvedRequirement[] = [];

  for (const requirement of template.manifest.requires ?? []) {
    const site = requirementSite(template.graph, requirement);
    if (!site) continue;

    const spec = info[site.nodeClass];
    const declared =
      spec?.input?.required?.[site.inputName] ?? spec?.input?.optional?.[site.inputName];
    const available = comboOptions(declared);

    const candidates = available ? rankCandidates(requirement, available) : [];
    out.push({
      requirement,
      site,
      available,
      candidates,
      filename: candidates[0] ?? null,
    });
  }

  return out;
}

/**
 * The graph, with every requirement that resolved written in.
 *
 * Returns a new graph and never mutates the one it is given — templates are
 * module-level constants shared by concurrent jobs, and the compiler's own
 * output is the only thing this is ever applied to.
 *
 * **How to wire this in.** One call in `orchestrator/dispatch.ts`, immediately
 * after the init-image rewrite and before `preflight`:
 *
 * ```ts
 * const info = await objectInfoFor(backend.base_url).catch(() => null);
 * if (info) graph = withResolvedRequirements(graph, template, info);
 * ```
 *
 * `objectInfoFor` is already awaited a few lines later by `preflight`, and its
 * cache means this costs nothing extra. Failing open — keeping the template's
 * literal when `/object_info` cannot be read — matches what `preflight` does
 * with the same failure, for the same reason: a flaky poll must not become "you
 * may not generate".
 */
export function withResolvedRequirements(
  graph: ComfyApiGraph,
  template: WorkflowTemplate,
  info: ObjectInfo,
): ComfyApiGraph {
  const resolved = resolveRequirements(template, info);
  const writes = resolved.filter(
    (r) => r.filename !== null && !sameModelFile(r.filename, r.site.literal ?? ''),
  );
  if (writes.length === 0) return graph;

  const next: Record<string, ComfyApiGraph[string]> = { ...graph };
  for (const write of writes) {
    const node = next[write.site.nodeId];
    if (!node) continue;
    next[write.site.nodeId] = {
      ...node,
      inputs: { ...node.inputs, [write.site.inputName]: write.filename as string },
    };
  }
  return next;
}

/**
 * Every requirement a manifest declares, or an empty array. A convenience so
 * callers do not each repeat the `?? []`.
 */
export function requirementsOf(manifest: WorkflowManifest): readonly ModelRequirement[] {
  return manifest.requires ?? [];
}
