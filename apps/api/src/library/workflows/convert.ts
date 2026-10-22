/** Server-side editor conversion. Missing specs and ambiguous wiring are
 * reported, never repaired by inventing input names or dropping widget values. */
import { z } from 'zod';
import type { ComfyApiNode, NodeInputValue } from '../../workflows/types.js';
import type { ObjectInfo } from '../../lib/comfy.js';

const port = z.object({ name: z.string(), type: z.union([z.string(), z.number()]).optional(), link: z.union([z.number(), z.string()]).nullable().optional(), widget: z.unknown().optional() }).passthrough();
const nodeSchema = z.object({
  id: z.union([z.number(), z.string()]), type: z.string(), mode: z.number().optional(),
  inputs: z.array(port).default([]), outputs: z.array(z.object({ type: z.union([z.string(), z.number()]).optional() }).passthrough()).default([]),
  widgets_values: z.array(z.unknown()).default([]), properties: z.record(z.unknown()).default({}),
}).passthrough();
const graphSchema = z.object({ nodes: z.array(nodeSchema), links: z.array(z.unknown()).default([]) }).passthrough();
export type EditorNode = z.infer<typeof nodeSchema>;
interface Link { id: string; from: string; slot: number; to: string; input: number }
interface Subgraph extends z.infer<typeof graphSchema> {
  id: string; inputs: { name: string; type: string | number }[];
  inputNode: { id: string | number }; outputNode: { id: string | number };
}
export interface NodeSpec {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
  input_order?: { required?: string[]; optional?: string[] };
  output?: (string | number)[];
  output_node?: boolean;
}
export type ConversionSpecs = ObjectInfo & Record<string, NodeSpec>;
export interface ConversionResult {
  graph: Record<string, ComfyApiNode>;
  nodes: Record<string, EditorNode>;
  issues: string[];
  missingNodes: string[];
}
const PRIMITIVES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
const NOTES = new Set(['Note', 'MarkdownNote']);
function linksOf(values: unknown[]): Link[] {
  return values.map((value) => {
    if (Array.isArray(value)) return { id: String(value[0]), from: String(value[1]), slot: Number(value[2]), to: String(value[3]), input: Number(value[4]) };
    const v = value as Record<string, unknown>;
    return { id: String(v.id), from: String(v.origin_id), slot: Number(v.origin_slot), to: String(v.target_id), input: Number(v.target_slot) };
  });
}
function literal(value: unknown): value is Exclude<NodeInputValue, readonly [string, number]> {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

export function convertWorkflow(value: unknown, specs: ConversionSpecs): ConversionResult {
  const root = graphSchema.parse(value);
  const definitions = (root.definitions as { subgraphs?: unknown[] } | undefined)?.subgraphs ?? [];
  const defs = new Map<string, Subgraph>();
  for (const raw of definitions) {
    const def = graphSchema.parse(raw) as unknown as Subgraph;
    if (!def.id || !Array.isArray(def.inputs) || !def.inputNode || !def.outputNode) throw new Error('Malformed subgraph interface.');
    defs.set(def.id, def);
  }
  const result: ConversionResult = { graph: {}, nodes: {}, issues: [], missingNodes: [] };
  const missing = new Set<string>();
  let count = 0;

  function scope(editor: z.infer<typeof graphSchema>, prefix: string, external: Map<number, NodeInputValue>, stack: string[]) {
    if (stack.length > 20) throw new Error('Subgraph nesting exceeds 20 levels.');
    const nodes = new Map(editor.nodes.map((node) => [String(node.id), node]));
    if (nodes.size !== editor.nodes.length) throw new Error('Duplicate editor node ids.');
    const links = linksOf(editor.links);
    const byLink = new Map(links.map((link) => [link.id, link]));
    const expanded = new Map<string, ReturnType<typeof scope>>();
    const fullId = (id: string) => prefix ? `${prefix}_${id}` : id;
    const active = new Set<string>();

    function expand(node: EditorNode) {
      const id = String(node.id);
      if (expanded.has(id)) return expanded.get(id)!;
      const def = defs.get(node.type)!;
      if (stack.includes(def.id)) throw new Error('Recursive subgraph definition.');
      const values = new Map<number, NodeInputValue>();
      let widget = 0;
      def.inputs.forEach((input, index) => {
        const port = node.inputs.find((candidate) => candidate.name === input.name);
        const isWidget = PRIMITIVES.has(String(input.type));
        const value = isWidget ? node.widgets_values[widget++] : undefined;
        const resolved = port?.link != null ? resolveLink(String(port.link)) : value;
        if (literal(resolved) || Array.isArray(resolved)) values.set(index, resolved as NodeInputValue);
      });
      if (widget !== node.widgets_values.length) result.issues.push(`${fullId(id)}: cannot map all subgraph widgets.`);
      const nested = scope(def, fullId(id), values, [...stack, def.id]);
      expanded.set(id, nested);
      return nested;
    }

    function resolveOutput(id: string, slot: number): NodeInputValue | undefined {
      const marker = `${id}:${slot}`;
      if (active.has(marker)) throw new Error('Cyclic editor links.');
      active.add(marker);
      try {
        const inputNode = (editor as unknown as Subgraph).inputNode;
        if (inputNode && id === String(inputNode.id)) return external.get(slot);
        const node = nodes.get(id);
        if (!node) throw new Error(`Link references missing node ${fullId(id)}.`);
        if (node.mode === 2 || NOTES.has(node.type)) return undefined;
        if (defs.has(node.type)) return expand(node).output(slot);
        if (node.type === 'PrimitiveNode') {
          const value = node.widgets_values[0];
          if (!literal(value)) throw new Error(`Primitive ${fullId(id)} has no scalar value.`);
          return value;
        }
        if (node.type === 'Reroute' || node.mode === 4) {
          const type = node.outputs[slot]?.type ?? specs[node.type]?.output?.[slot];
          const candidates = node.inputs.filter((input) => input.link != null && (node.type === 'Reroute' || input.type === type));
          // Match the same slot first, as LiteGraph does; otherwise require one
          // unambiguous input of the output type.
          const same = node.inputs[slot];
          const input = same?.link != null && (same.type === type || node.type === 'Reroute') ? same : candidates.length === 1 ? candidates[0] : undefined;
          if (!input) return undefined;
          return resolveLink(String(input.link));
        }
        return [fullId(id), slot];
      } finally { active.delete(marker); }
    }
    function resolveLink(id: string): NodeInputValue | undefined {
      const link = byLink.get(id);
      if (!link || !Number.isInteger(link.slot) || link.slot < 0) throw new Error(`Invalid link ${id}.`);
      return resolveOutput(link.from, link.slot);
    }

    for (const node of nodes.values()) {
      if (++count > 10_000) throw new Error('Workflow exceeds 10,000 nodes.');
      if (node.mode === 2 || node.mode === 4 || NOTES.has(node.type) || ['Reroute', 'PrimitiveNode'].includes(node.type)) continue;
      if (defs.has(node.type)) { expand(node); continue; }
      const id = fullId(String(node.id));
      if (!/^[A-Za-z0-9_-]+$/.test(id) || id in result.graph) throw new Error('Invalid or colliding flattened node id.');
      const spec = specs[node.type];
      if (!spec) { missing.add(node.type); continue; }
      const inputs: Record<string, NodeInputValue> = {};
      const declared = { ...spec.input?.required, ...spec.input?.optional };
      const names = [...(spec.input_order?.required ?? Object.keys(spec.input?.required ?? {})), ...(spec.input_order?.optional ?? Object.keys(spec.input?.optional ?? {}))];
      let widget = 0;
      function bind(name: string, desc: unknown, required: boolean) {
        if (!Array.isArray(desc)) { result.issues.push(`${id}.${name}: unsupported input specification.`); return; }
        const [type, options = {}] = desc as [unknown, Record<string, unknown>];
        if (options.hidden === true) return;
        if (type === 'COMFY_AUTOGROW_V3') {
          const template = options.template as { names?: string[]; prefix?: string; min?: number; max?: number; input?: { required?: Record<string, unknown> } };
          const children = template.names ?? Array.from({ length: Math.min(template.max ?? 0, 1000) }, (_, i) => `${template.prefix}${i}`);
          const childSpec = Object.values(template.input?.required ?? {})[0];
          let connected = 0;
          for (const child of children) {
            const fullName = `${name}.${child}`;
            if (node.inputs.some((input) => input.name === fullName && input.link != null)) {
              bind(fullName, childSpec, true); connected++;
            }
          }
          if (connected < (template.min ?? 0)) result.issues.push(`${id}.${name}: not enough connected inputs.`);
          return;
        }
        const port = node.inputs.find((input) => input.name === name);
        const link = port?.link != null ? byLink.get(String(port.link)) : links.find((candidate) => candidate.to === String(node.id) && node.inputs[candidate.input]?.name === name);
        if (port?.link != null && !link) result.issues.push(`${id}.${name}: missing link ${port.link}.`);
        const dynamic = type === 'COMFY_DYNAMICCOMBO_V3';
        const widgetInput = options.forceInput !== true && (dynamic || Array.isArray(type) || PRIMITIVES.has(String(type)));
        let val: unknown;
        if (widgetInput) {
          val = node.widgets_values[widget++];
          if ((name === 'seed' || name === 'noise_seed' || Boolean(options.control_after_generate)) &&
            ['fixed', 'randomize', 'increment', 'decrement'].includes(String(node.widgets_values[widget]))) widget++;
          if (val === undefined) val = options.default;
        }
        if (link) val = resolveOutput(link.from, link.slot);
        if (literal(val) || Array.isArray(val) && typeof val[0] === 'string' && Number.isInteger(val[1])) inputs[name] = val as NodeInputValue;
        else if (required) result.issues.push(`${id}.${name}: required input has no value.`);
        if (dynamic && val !== undefined) {
          const choices = options.options as { key: string; inputs: NodeSpec['input'] }[];
          const choice = choices.find((option) => option.key === val);
          if (!choice) { result.issues.push(`${id}.${name}: unsupported dynamic option.`); return; }
          for (const [child, spec] of Object.entries(choice.inputs?.required ?? {})) bind(`${name}.${child}`, spec, true);
          for (const [child, spec] of Object.entries(choice.inputs?.optional ?? {})) bind(`${name}.${child}`, spec, false);
        }
      }
      for (const name of names) bind(name, declared[name], Object.hasOwn(spec.input?.required ?? {}, name));
      // LoadImage serializes its upload button after the filename.
      const tail = node.widgets_values.slice(widget);
      if (tail.length && !(node.type === 'LoadImage' && tail.length === 1 && tail[0] === 'image')) result.issues.push(`${id}: ${tail.length} unmapped widget value(s).`);
      result.graph[id] = { class_type: node.type, inputs };
      result.nodes[id] = node;
    }
    return { output(slot: number): NodeInputValue | undefined {
      const outputNode = (editor as unknown as Subgraph).outputNode;
      const link = links.find((candidate) => outputNode && candidate.to === String(outputNode.id) && candidate.input === slot);
      if (!link) throw new Error(`Subgraph output ${slot} has no link.`);
      return resolveOutput(link.from, link.slot);
    } };
  }
  scope(root, '', new Map(), []);
  collapseConstantSwitches(result.graph);
  pruneUnreachable(result, specs);
  result.missingNodes = [...missing].sort();
  for (const [id, node] of Object.entries(result.graph)) {
    for (const val of Object.values(node.inputs)) {
      if (Array.isArray(val) && !result.graph[val[0]]) result.issues.push(`${id}: linked node ${val[0]} could not be converted.`);
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error('Cyclic editor links.');
    if (visited.has(id) || !result.graph[id]) return;
    visiting.add(id);
    for (const value of Object.values(result.graph[id]!.inputs)) {
      if (Array.isArray(value)) visit(value[0]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  Object.keys(result.graph).forEach(visit);
  return result;
}

/** Nodes that pass one of two inputs on, chosen by a boolean. */
const SWITCHES: Record<string, { switch: string; onTrue: string; onFalse: string }> = {
  ComfySwitchNode: { switch: 'switch', onTrue: 'on_true', onFalse: 'on_false' },
};
/** A literal, or the literal value of the primitive node a link points at. */
export function constantOf(graph: Record<string, ComfyApiNode>, value: NodeInputValue | undefined): NodeInputValue | undefined {
  if (!Array.isArray(value)) return value;
  const node = graph[value[0]];
  if (node && /^Primitive/.test(node.class_type) && !Array.isArray(node.inputs.value)) return node.inputs.value;
  return undefined;
}

/**
 * A switch set to a fixed value in the official file (the MiniMax H3 "turbo
 * LoRA" toggle) is replaced by the branch it picks, so the branch it does not
 * pick is neither validated nor downloaded.
 */
export function collapseConstantSwitches(graph: Record<string, ComfyApiNode>) {
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, node] of Object.entries(graph)) {
      const names = SWITCHES[node.class_type];
      if (!names) continue;
      const on = constantOf(graph, node.inputs[names.switch]);
      if (typeof on !== 'boolean') continue;
      const chosen = node.inputs[on ? names.onTrue : names.onFalse];
      if (chosen === undefined) continue;
      for (const other of Object.values(graph)) {
        for (const [name, value] of Object.entries(other.inputs)) {
          if (Array.isArray(value) && value[0] === id) (other.inputs as Record<string, NodeInputValue>)[name] = chosen;
        }
      }
      delete graph[id];
      changed = true;
    }
  }
}

/**
 * ComfyUI runs, and validates, only what an output node depends on. Nodes left
 * lying beside the graph (an unwired resize in MiniMax H3's image-to-video, a
 * switch branch not taken) are dropped with whatever they reported.
 */
export function pruneUnreachable(result: Pick<ConversionResult, 'graph' | 'nodes' | 'issues'>, specs: ConversionSpecs) {
  const outputs = Object.keys(result.graph).filter((id) => specs[result.graph[id]!.class_type]?.output_node === true);
  if (!outputs.length) return;
  const keep = new Set<string>();
  const visit = (id: string) => {
    if (keep.has(id) || !result.graph[id]) return;
    keep.add(id);
    for (const value of Object.values(result.graph[id]!.inputs)) if (Array.isArray(value)) visit(value[0]);
  };
  outputs.forEach(visit);
  const dropped = Object.keys(result.graph).filter((id) => !keep.has(id));
  for (const id of dropped) { delete result.graph[id]; delete result.nodes[id]; }
  const gone = new Set(dropped);
  result.issues = result.issues.filter((issue) => !gone.has(/^([A-Za-z0-9_-]+)[.:]/.exec(issue)?.[1] ?? ''));
}
