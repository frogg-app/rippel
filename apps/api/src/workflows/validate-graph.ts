/**
 * Checking a hand-authored graph against what ComfyUI actually declares —
 * without a ComfyUI.
 *
 * ## The rule this enforces, and why it needed teeth
 *
 * `MODELS_PLAN.md`'s ground rules say: "Read node specs from the backend.
 * Before writing a graph, fetch each node's inputs from `/object_info`. Do not
 * write graphs from memory; ComfyUI's inputs change between versions."
 *
 * That rule was enforced by whoever happened to be reading it. The failure it
 * guards against is quiet and expensive: a misspelled input name is accepted by
 * every test we have — the path tests only check that a manifest path resolves
 * to *something* in the graph — and then rejected by ComfyUI at dispatch, after
 * the user has waited. Worse, the reference backend is not always reachable, so
 * "go and check" is not always an option at the moment you need it.
 *
 * So the specs are captured to a fixture and the check runs offline, every time
 * the suite does.
 *
 * ## Partial by design, and honest about it
 *
 * The fixture holds only the classes someone has captured, and a class it does
 * not know is **skipped, not failed**. Anything else would make adding a
 * template require capturing every node in it before the tests would pass,
 * which turns a safety net into a blocker. `coverageOf` reports the gap so it
 * is visible rather than silent.
 *
 * Two kinds of value are never checked, for the same reason: they are not
 * properties of the graph.
 *
 *   - **File-list enums** (`ckpt_name`, `unet_name`, `vae_name`, `image`) are
 *     whatever is installed on that machine. A graph naming a file the backend
 *     does not have is a *readiness* problem, which `readiness.ts` already
 *     answers properly, with a download attached.
 *   - **Enums captured incompletely.** `KSampler.sampler_name` has 45 entries
 *     and the capture kept ten. Validating against a partial list would reject
 *     valid samplers, so the fixture marks completeness per enum and this
 *     refuses to judge the ones it cannot.
 */

import fixture from './__fixtures__/object-info.json' with { type: 'json' };
import type { ComfyApiGraph } from './types.js';
import { isNodeLink } from './paths.js';

interface InputSpec {
  type: string;
  values?: string[];
  enumComplete?: boolean;
  fileList?: boolean;
  min?: number;
  max?: number;
}

interface NodeSpec {
  required?: Record<string, InputSpec>;
  optional?: Record<string, InputSpec>;
}

const NODES = fixture.nodes as unknown as Record<string, NodeSpec>;

export interface GraphProblem {
  nodeId: string;
  nodeClass: string;
  input?: string;
  message: string;
}

/** Which of a graph's classes the fixture can speak to. */
export function coverageOf(graph: ComfyApiGraph): { known: string[]; unknown: string[] } {
  const classes = [...new Set(Object.values(graph).map((node) => node.class_type))].sort();
  return {
    known: classes.filter((c) => NODES[c]),
    unknown: classes.filter((c) => !NODES[c]),
  };
}

/**
 * Every way this graph disagrees with the captured specs.
 *
 * Empty means "nothing the fixture knows about is wrong", which is a weaker
 * claim than "correct" and is the strongest one available offline.
 */
export function validateGraph(graph: ComfyApiGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];

  for (const [nodeId, node] of Object.entries(graph)) {
    const spec = NODES[node.class_type];
    if (!spec) continue;

    const required = spec.required ?? {};
    const optional = spec.optional ?? {};
    const declared = { ...required, ...optional };
    const fail = (message: string, input?: string) =>
      problems.push({ nodeId, nodeClass: node.class_type, input, message });

    for (const name of Object.keys(required)) {
      if (!(name in node.inputs)) fail(`required input "${name}" is missing`, name);
    }

    for (const [name, value] of Object.entries(node.inputs)) {
      const input = declared[name];
      if (!input) {
        // The typo case, and the reason this module exists.
        fail(`no input named "${name}" on ${node.class_type}`, name);
        continue;
      }

      // A link is a wiring claim, not a value one: check it points somewhere.
      if (isNodeLink(value)) {
        const [target] = value as [string, number];
        if (!graph[String(target)]) fail(`is wired to node "${target}", which does not exist`, name);
        continue;
      }

      if (input.type === 'ENUM') {
        if (input.fileList || input.enumComplete !== true || !input.values) continue;
        if (typeof value !== 'string' || !input.values.includes(value)) {
          fail(`"${String(value)}" is not one of ${input.values.join(', ')}`, name);
        }
        continue;
      }

      if ((input.type === 'INT' || input.type === 'FLOAT') && typeof value === 'number') {
        if (input.min !== undefined && value < input.min) {
          fail(`${value} is below the minimum of ${input.min}`, name);
        }
        if (input.max !== undefined && value > input.max) {
          fail(`${value} is above the maximum of ${input.max}`, name);
        }
      }
    }
  }

  return problems;
}

/** One line per problem, for a test failure somebody has to read at 2am. */
export function describeProblems(problems: GraphProblem[]): string {
  return problems
    .map((p) => `  ${p.nodeId} (${p.nodeClass})${p.input ? `.${p.input}` : ''}: ${p.message}`)
    .join('\n');
}
