/**
 * Editor format to API format, on the server, without a browser.
 *
 * ## Why rippel has to do this at all
 *
 * ComfyUI's library files are what its node editor saves: nodes with positional
 * `widgets_values` and a separate list of links. `POST /prompt` accepts none of
 * that. It wants `{ [id]: { class_type, inputs: { name: value | [id, slot] } } }`.
 * The browser frontend converts one to the other when you press Queue, and it is
 * the only thing that does. rippel has no browser in the loop, so either it
 * converts on the server or every library workflow is re-typed by hand — which is
 * how the nine built-in templates came to exist, and why there are only nine.
 *
 * ## The one hard part: widget values have no names
 *
 * `widgets_values` for the library's KSampler is `[898471028164125, "randomize",
 * 20, 5, "uni_pc", "simple", 1]`. Nothing in the file says which number is steps.
 * The names come from the node's declared inputs, in declaration order, counting
 * only the ones that are widgets rather than sockets — and the frontend inserts
 * one value the node never declared, the "control after generate" choice after a
 * seed. Get the count wrong by one and every value after it shifts: steps becomes
 * the seed, cfg becomes steps, and ComfyUI accepts the lot, because they are all
 * numbers. So the mapping reads node specs rather than guessing, refuses a node
 * whose specs it does not have, and refuses a node whose value count does not
 * fit, rather than emitting something plausible.
 *
 * ## What it resolves, and what it refuses
 *
 *   - **Links** become `[originId, slot]`, followed through `Reroute` nodes.
 *   - **Muted nodes** (mode 2) are left out, and inputs wired from them are left
 *     unset. **Bypassed nodes** (mode 4) are left out, and an input wired from one
 *     is re-wired to whatever feeds the bypassed node's first input of the same
 *     type, which is what ComfyUI's bypass does. A bypassed node with no such
 *     input — the library's disabled `LoadImage` — leaves the input unset.
 *   - **Display-only nodes** (`Note`, `MarkdownNote`) are dropped.
 *   - **`PrimitiveNode`** is a frontend-only node that holds a value for a widget
 *     turned into a socket. Its value is inlined.
 *   - **Subgraphs** are refused, by name. MODELS_PLAN says newer library files
 *     use them; flattening needs a real subgraph file to test against and we have
 *     none, and a flattener written blind is exactly the graph-from-memory the
 *     project's ground rules forbid.
 *
 * Every refusal is a `problem`, and a result with problems is not a graph anyone
 * should submit. The graph is still returned, so the problems can be read in
 * context.
 *
 * ## How well this is tested
 *
 * Against one real file: `video_wan2_2_5B_ti2v`, which is flat, has one bypassed
 * node and no reroutes or primitives. Its output matches the hand-written
 * `img2vid-wan22-ti2v-5b` graph node for node and link for link, and passes
 * `validate-graph`. Reroute, PrimitiveNode, muting and converted widgets are
 * covered only by small synthetic graphs in the tests, which check this code's
 * logic and prove nothing about ComfyUI's. Nothing converted here has been
 * submitted to a real `/prompt`.
 */

import type { ObjectInfo } from '../../lib/comfy.js';
import type { ComfyApiGraph, ComfyApiNode, NodeInputValue } from '../types.js';
import type { InputSpec, NodeSpec } from '../validate-graph.js';
import {
  MODE_ACTIVE,
  MODE_BYPASSED,
  MODE_MUTED,
  type LibraryTemplate,
  type LiteGraphNode,
} from './litegraph.js';

/** Nodes that exist only on the canvas. */
const DISPLAY_ONLY = new Set(['Note', 'MarkdownNote']);

/**
 * Types the editor draws as a widget rather than a socket.
 *
 * `COMFY_DYNAMICCOMBO_V3` is here because `SaveVideo.format` and `.codec` are
 * declared with it on ComfyUI 0.35.0 and the library file holds a value for each
 * ("auto", "auto"). Without it they are read as sockets and `format`, which is
 * required, is reported missing.
 */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'ENUM', 'COMBO', 'COMFY_DYNAMICCOMBO_V3']);

/** The values of the frontend's extra "control after generate" widget. */
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize']);

export interface ConversionProblem {
  nodeId: string | null;
  nodeClass: string | null;
  message: string;
}

export interface ConversionResult {
  graph: ComfyApiGraph;
  problems: ConversionProblem[];
  /** Nodes left out because they were muted or bypassed as shipped. */
  inactive: { nodeId: string; nodeClass: string }[];
}

export interface ConversionOptions {
  /**
   * Editor node ids to treat as active whatever their shipped mode. The Wan 5B
   * file ships its image loader bypassed; image-to-video is that file with the
   * loader switched on, and this is the switch.
   */
  activate?: readonly string[];
}

function isWidget(spec: InputSpec): boolean {
  return WIDGET_TYPES.has(spec.type) && spec.forceInput !== true;
}

/** Declared inputs in declaration order, required first, as the editor lays them out. */
function declaredInputs(spec: NodeSpec): [string, InputSpec][] {
  return [...Object.entries(spec.required ?? {}), ...Object.entries(spec.optional ?? {})];
}

/**
 * Whether the frontend put a control-after-generate value after this widget.
 *
 * It does so for an INT whose spec says `control_after_generate`, and — in every
 * frontend we have seen — for any INT called `seed` or `noise_seed` whether the
 * spec says so or not. The captured specs do not record the flag, so the name is
 * the evidence. The value itself is checked as well: a skip that would swallow a
 * real number is not a skip.
 */
function hasControlValue(name: string, spec: InputSpec, next: unknown): boolean {
  if (spec.type !== 'INT') return false;
  if (typeof next !== 'string' || !CONTROL_VALUES.has(next)) return false;
  return spec.controlAfterGenerate === true || name === 'seed' || name === 'noise_seed';
}

export function convertLibraryWorkflow(
  template: LibraryTemplate,
  specs: Readonly<Record<string, NodeSpec>>,
  options: ConversionOptions = {},
): ConversionResult {
  const problems: ConversionProblem[] = [];
  const inactive: { nodeId: string; nodeClass: string }[] = [];
  const activate = new Set(options.activate ?? []);
  const byId = new Map(template.nodes.map((node) => [node.id, node]));
  const modeOf = (node: LiteGraphNode) => (activate.has(node.id) ? MODE_ACTIVE : node.mode);

  for (const id of template.subgraphIds) {
    problems.push({
      nodeId: null,
      nodeClass: null,
      message: `Uses subgraph ${id}. Flattening subgraphs is not built yet, so this workflow cannot be converted.`,
    });
  }

  /**
   * What an input wired by `linkId` actually receives: a link to a real node, a
   * literal from a PrimitiveNode, or nothing. `seen` stops a cycle of reroutes
   * or bypasses from looping forever; a cycle is a broken file, not a graph.
   */
  function resolveLink(linkId: number, seen = new Set<number>()): NodeInputValue | null {
    if (seen.has(linkId)) return null;
    seen.add(linkId);
    const link = template.links.get(linkId);
    if (!link) return null;
    const origin = byId.get(link.originId);
    if (!origin) return null;

    if (origin.type === 'Reroute') {
      const upstream = origin.inputs[0]?.link;
      return upstream === null || upstream === undefined ? null : resolveLink(upstream, seen);
    }
    if (origin.type === 'PrimitiveNode') {
      const value = origin.widgetsValues[0];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : null;
    }

    const mode = modeOf(origin);
    if (mode === MODE_MUTED) return null;
    if (mode === MODE_BYPASSED) {
      const through = origin.inputs.find((input) => input.type === link.type && input.link !== null);
      return through?.link === null || through?.link === undefined ? null : resolveLink(through.link, seen);
    }
    return [origin.id, link.originSlot];
  }

  const graph: Record<string, ComfyApiNode> = {};

  for (const node of template.nodes) {
    if (DISPLAY_ONLY.has(node.type) || node.type === 'Reroute' || node.type === 'PrimitiveNode') continue;
    if (template.subgraphIds.includes(node.type)) continue;
    const mode = modeOf(node);
    if (mode !== MODE_ACTIVE) {
      inactive.push({ nodeId: node.id, nodeClass: node.type });
      continue;
    }

    const fail = (message: string) => problems.push({ nodeId: node.id, nodeClass: node.type, message });
    const spec = specs[node.type];
    const inputs: Record<string, NodeInputValue> = {};

    // Sockets first: they are named in the file, so they need no spec.
    for (const socket of node.inputs) {
      if (socket.link === null) continue;
      const value = resolveLink(socket.link);
      if (value !== null) inputs[socket.widget?.name ?? socket.name] = value;
    }

    if (!spec) {
      fail(
        `No node spec for ${node.type}, so its ${node.widgetsValues.length} widget values cannot be named. ` +
          'It is either a custom node or one missing from the captured specs.',
      );
      graph[node.id] = { class_type: node.type, inputs, _meta: { title: node.title ?? node.type } };
      continue;
    }

    const values = node.widgetsValues;
    let cursor = 0;
    for (const [name, input] of declaredInputs(spec)) {
      if (!isWidget(input)) continue;
      // A widget turned into a socket still owns its slot in widgets_values.
      const converted = node.inputs.some((socket) => socket.widget?.name === name);
      if (cursor >= values.length) {
        if (spec.required?.[name] && !(name in inputs)) {
          fail(`has no value for "${name}": the file holds fewer widget values than ${node.type} declares.`);
        }
        break;
      }
      const value = values[cursor++];
      if (hasControlValue(name, input, values[cursor])) cursor++;
      if (converted && name in inputs) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        inputs[name] = value;
      } else if (converted) {
        continue;
      } else {
        fail(`"${name}" holds a ${value === null ? 'null' : typeof value}, which is not a widget value.`);
      }
    }

    for (const name of Object.keys(spec.required ?? {})) {
      if (!(name in inputs) && !problems.some((p) => p.nodeId === node.id && p.message.includes(`"${name}"`))) {
        fail(`required input "${name}" is not connected.`);
      }
    }

    graph[node.id] = { class_type: node.type, inputs, _meta: { title: node.title ?? node.type } };
  }

  // A link into a node that was never emitted (an unknown subgraph instance)
  // would be a dangling reference ComfyUI rejects; say so here instead.
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && !graph[String(value[0])]) {
        problems.push({
          nodeId,
          nodeClass: node.class_type,
          message: `"${name}" is wired to node ${String(value[0])}, which did not convert.`,
        });
      }
    }
  }

  return { graph, problems, inactive };
}

/**
 * Node specs from a live `/object_info`, in the shape the captured fixture uses.
 *
 * The live format is `input.required[name] = [typeOrOptions, config]`, where the
 * first element is a type name, the literal "COMBO" with options in the config,
 * or (older) the option list itself. `input_order` gives the declaration order
 * when the backend sends it, and it is preferred to key order because the
 * widget mapping above depends on nothing else.
 */
export function nodeSpecsFromObjectInfo(info: ObjectInfo): Record<string, NodeSpec> {
  const out: Record<string, NodeSpec> = {};
  for (const [nodeClass, entry] of Object.entries(info)) {
    const raw = entry as {
      input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
      input_order?: { required?: string[]; optional?: string[] };
    };
    const spec: NodeSpec = {};
    for (const group of ['required', 'optional'] as const) {
      const declared = raw.input?.[group];
      if (!declared) continue;
      const order = raw.input_order?.[group] ?? Object.keys(declared);
      const inputs: Record<string, InputSpec> = {};
      for (const name of order) {
        const parsed = parseInputSpec(declared[name]);
        if (parsed) inputs[name] = parsed;
      }
      spec[group] = inputs;
    }
    out[nodeClass] = spec;
  }
  return out;
}

function parseInputSpec(raw: unknown): InputSpec | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const [head, config] = raw as [unknown, Record<string, unknown> | undefined];
  const opts = config && typeof config === 'object' ? config : {};
  const extra = {
    ...(opts.forceInput === true ? { forceInput: true } : {}),
    ...(opts.control_after_generate === true ? { controlAfterGenerate: true } : {}),
  };
  if (Array.isArray(head)) {
    return { type: 'ENUM', values: head.map(String), enumComplete: true, ...extra };
  }
  if (head === 'COMBO') {
    const values = Array.isArray(opts.options) ? opts.options.map(String) : [];
    return { type: 'ENUM', values, enumComplete: true, ...extra };
  }
  if (typeof head !== 'string') return null;
  return {
    type: head,
    ...(typeof opts.min === 'number' ? { min: opts.min } : {}),
    ...(typeof opts.max === 'number' ? { max: opts.max } : {}),
    ...extra,
  };
}
