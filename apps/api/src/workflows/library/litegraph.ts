/**
 * Reading ComfyUI's own workflow library — the files, not the graphs.
 *
 * ## Why this is its own module
 *
 * Every ComfyUI install serves some five hundred ready-made workflows at
 * `/templates/<name>.json`, and every rippel workflow so far has been written by
 * hand. The obvious move is a converter, and `convert.ts` is that. But most of
 * what a person needs from a library workflow does not need converting at all:
 * each loader node in the file carries `properties.models`, naming the file it
 * loads, the folder it belongs in and a URL to fetch it from. That is the answer
 * to "what do I have to download to use this", and it is exactly the answer the
 * models screen stopped being able to give when ComfyUI-Manager went away from
 * the reference machine and took the install catalogue with it.
 *
 * So the file format is parsed here, once, and the two consumers — the model
 * list and the converter — both read the parsed shape. Neither has to know that
 * links are positional six-element arrays.
 *
 * ## What the format is, as observed rather than as documented
 *
 * Read off the real `video_wan2_2_5B_ti2v` file (frontend 1.27.10, library on
 * ComfyUI 0.35.0), saved as `models/__fixtures__/library-template-wan22-5b.json`:
 *
 *   - `nodes[]`: `{id, type, mode, inputs[], outputs[], widgets_values[], properties}`.
 *     `inputs` holds sockets only, each `{name, type, link}` where `link` is a
 *     link id or null. A widget converted into a socket also carries `widget`.
 *   - `links[]`: `[linkId, originNode, originSlot, targetNode, targetSlot, type]`.
 *   - `mode`: 0 runs, 2 is muted, 4 is bypassed. The file ships its `LoadImage`
 *     at mode 4, so the workflow is text-to-video until someone switches the
 *     image on. That is not an edge case; it is the first file we read.
 *
 * Subgraphs (`definitions.subgraphs`) are recognised so they can be refused by
 * name, not guessed at. `video_wan2_2_14B_i2v` uses one, and we have no copy.
 *
 * ## Trust
 *
 * A URL in a library file is shown to a person, never fetched by this code.
 * `trustedSource` marks the ones a future download path may act on, using the
 * rule MODELS_PLAN sets for the agent: HTTPS, Hugging Face or Civitai only.
 */

/** A library file that is not the editor format this code understands. */
export class LibraryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryFormatError';
  }
}

/** Node modes as the editor stores them. */
export const MODE_ACTIVE = 0;
export const MODE_MUTED = 2;
export const MODE_BYPASSED = 4;

export interface LiteGraphInput {
  name: string;
  type: string;
  link: number | null;
  /** Present when a widget was converted to a socket. */
  widget?: { name: string };
}

export interface LiteGraphModelRef {
  name: string;
  url: string;
  directory: string;
}

export interface LiteGraphNode {
  id: string;
  type: string;
  mode: number;
  title: string | null;
  inputs: LiteGraphInput[];
  widgetsValues: unknown[];
  models: LiteGraphModelRef[];
}

export interface LiteGraphLink {
  id: number;
  originId: string;
  originSlot: number;
  targetId: string;
  targetSlot: number;
  type: string;
}

export interface LibraryTemplate {
  nodes: LiteGraphNode[];
  links: Map<number, LiteGraphLink>;
  /** Ids of subgraph definitions. Non-empty means the converter will refuse. */
  subgraphIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a library file, refusing anything that is not the editor format.
 *
 * Strict about structure and lenient about content: a node missing `inputs` has
 * none, but a `links` entry that is not a six-element array means the format has
 * changed under us, and continuing would produce a graph wired wrongly in ways
 * no later check could see.
 */
export function parseLibraryTemplate(raw: unknown): LibraryTemplate {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) {
    // The API format is a flat map of id -> {class_type}. Say so: it is the
    // likeliest wrong file to be handed.
    throw new LibraryFormatError(
      'This is not a workflow in the ComfyUI editor format: it has no "nodes" list.',
    );
  }

  const nodes: LiteGraphNode[] = raw.nodes.map((entry, index) => {
    if (!isRecord(entry) || entry.id === undefined || typeof entry.type !== 'string') {
      throw new LibraryFormatError(`Node ${index} has no id or type.`);
    }
    const properties = isRecord(entry.properties) ? entry.properties : {};
    const models = Array.isArray(properties.models)
      ? properties.models.filter(
          (m): m is LiteGraphModelRef =>
            isRecord(m) &&
            typeof m.name === 'string' &&
            typeof m.url === 'string' &&
            typeof m.directory === 'string',
        )
      : [];
    const inputs: LiteGraphInput[] = Array.isArray(entry.inputs)
      ? entry.inputs.filter(isRecord).map((input) => ({
          name: String(input.name),
          type: String(input.type),
          link: typeof input.link === 'number' ? input.link : null,
          ...(isRecord(input.widget) && typeof input.widget.name === 'string'
            ? { widget: { name: input.widget.name } }
            : {}),
        }))
      : [];
    return {
      id: String(entry.id),
      type: entry.type,
      mode: typeof entry.mode === 'number' ? entry.mode : MODE_ACTIVE,
      title: typeof entry.title === 'string' ? entry.title : null,
      inputs,
      widgetsValues: Array.isArray(entry.widgets_values) ? entry.widgets_values : [],
      models,
    };
  });

  const links = new Map<number, LiteGraphLink>();
  for (const entry of Array.isArray(raw.links) ? raw.links : []) {
    if (!Array.isArray(entry) || entry.length < 6 || typeof entry[0] !== 'number') {
      throw new LibraryFormatError(
        'A link is not a [id, origin, slot, target, slot, type] array; the editor format has changed.',
      );
    }
    const [id, originId, originSlot, targetId, targetSlot, type] = entry as unknown[];
    links.set(id as number, {
      id: id as number,
      originId: String(originId),
      originSlot: Number(originSlot),
      targetId: String(targetId),
      targetSlot: Number(targetSlot),
      type: String(type),
    });
  }

  const definitions = isRecord(raw.definitions) ? raw.definitions : {};
  const subgraphIds = Array.isArray(definitions.subgraphs)
    ? definitions.subgraphs.filter(isRecord).map((s) => String(s.id))
    : [];

  return { nodes, links, subgraphIds };
}

/**
 * HTTPS from Hugging Face or Civitai. The same allowlist MODELS_PLAN gives the
 * agent's download endpoint, so nothing marked trusted here would be refused
 * there.
 */
export function isTrustedModelUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ['huggingface.co', 'civitai.com'].some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

export interface LibraryModelNeed {
  filename: string;
  folder: string;
  url: string;
  trustedSource: boolean;
  nodeIds: string[];
  /** True when every node naming it is muted or bypassed as shipped. */
  onlyOnInactiveNodes: boolean;
}

/**
 * Every model file a library workflow names, once each.
 *
 * Keyed by folder and filename together: the same name in two folders is two
 * files, and ComfyUI would treat them so. Order follows the file, which puts the
 * loaders first in every library workflow read so far — a list a person reads
 * top to bottom.
 *
 * Inactive nodes are kept and flagged rather than dropped. A bypassed loader is
 * one somebody may switch on, and "you will also need this if you do" is worth
 * knowing before a nine-gigabyte download rather than after.
 */
export function libraryModelsOf(template: LibraryTemplate): LibraryModelNeed[] {
  const byKey = new Map<string, LibraryModelNeed>();
  for (const node of template.nodes) {
    const active = node.mode === MODE_ACTIVE;
    for (const model of node.models) {
      const key = `${model.directory}/${model.name}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.nodeIds.push(node.id);
        existing.onlyOnInactiveNodes = existing.onlyOnInactiveNodes && !active;
        continue;
      }
      byKey.set(key, {
        filename: model.name,
        folder: model.directory,
        url: model.url,
        trustedSource: isTrustedModelUrl(model.url),
        nodeIds: [node.id],
        onlyOnInactiveNodes: !active,
      });
    }
  }
  return [...byKey.values()];
}
