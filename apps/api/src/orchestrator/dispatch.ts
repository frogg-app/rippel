/**
 * Turning a queued job into a prompt running on a backend.
 *
 * Ordering here is chosen so that a failure anywhere leaves a job in a state
 * that is true rather than merely tidy: we compile before we claim a backend,
 * claim the backend before we POST, and record ComfyUI's prompt id before we
 * report the job as dispatched. The one thing we must never do is tell the
 * user a job is running when nothing was submitted.
 */

import type { Uuid } from '@comfy/shared';
import { compile, TemplateError, ValidationError } from '../compiler/index.js';
import { sendStoredInitImageToBackend, withInitImage } from '../workflows/init-image.js';
import { withResolvedRequirements } from '../workflows/requirements.js';
import { objectInfoFor } from './preflight.js';
import type { ResolvedValues } from '../compiler/index.js';
import { chooseTemplate } from '../models/workflow-choice.js';
import { queryOne } from '../db.js';
import { filenamesOn, pickBackend, type Candidate } from './select.js';
import { preflight } from './preflight.js';
import type { JobRow } from './jobs.js';

export class DispatchError extends Error {
  constructor(
    message: string,
    /** True when the same job could succeed later — a backend being down. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}

/**
 * Where the bytes of an `init` reference live in our own storage.
 *
 * A reference is either an existing generation or a file the user dropped, and
 * the two are equal citizens by design (see `ImageSource` in the shared types).
 * They live in different tables, hence the two lookups; both are scoped to the
 * job's owner, so a crafted request cannot use somebody else's image as an init
 * frame.
 */
async function initImageKey(job: JobRow): Promise<string | null> {
  const init = job.params.references?.find((r) => r.role === 'init');
  if (!init) return null;

  if (init.source.from === 'asset') {
    const row = await queryOne<{ storage_key: string }>(
      `SELECT storage_key FROM assets
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [init.source.assetId, job.user_id],
    );
    if (!row) throw new DispatchError('That reference image is no longer in your library.', false);
    return row.storage_key;
  }

  const row = await queryOne<{ storage_key: string }>(
    'SELECT storage_key FROM uploads WHERE id = $1 AND user_id = $2',
    [init.source.uploadId, job.user_id],
  );
  if (!row) throw new DispatchError('That uploaded image could not be found.', false);
  return row.storage_key;
}

/** The model row a job's checkpoint comes from: its family, and what to call it. */
async function modelOf(
  modelId: Uuid,
): Promise<{ base_model: string | null; display_name: string; filename: string } | null> {
  return queryOne<{ base_model: string | null; display_name: string; filename: string }>(
    'SELECT base_model, display_name, filename FROM models WHERE id = $1',
    [modelId],
  );
}

export interface Dispatched {
  backend: Candidate;
  promptId: string;
  templateId: string;
  /** Everything the compiler decided, recorded so the job can be reproduced. */
  resolved: ResolvedValues;
  /**
   * Node id -> class_type for the graph we actually submitted, including any
   * LoRA loaders the compiler spliced in.
   *
   * The runner needs it to say what the backend is *doing*: ComfyUI's frames
   * name the node that is executing and nothing else, so without the classes
   * "executing node 8" cannot be turned into "decoding the image". Carried on
   * the dispatch result rather than re-derived later because this is the one
   * moment the exact submitted graph exists.
   */
  nodeClasses: Record<string, string>;
  /** What to call the weights in a progress label, e.g. "SDXL 1.0". */
  modelLabel: string;
}

/**
 * Compile a job and submit it. Returns once ComfyUI has accepted the prompt.
 *
 * `POST /prompt` is synchronous only in the sense that it validates the graph
 * and queues it; execution happens afterwards and is followed over the socket.
 * A 400 here is a graph ComfyUI refused, which is our bug rather than the
 * user's, so its body is worth keeping.
 */
export async function dispatch(job: JobRow, clientId: string): Promise<Dispatched> {
  const model = await modelOf(job.params.modelId);
  const family = model?.base_model ?? null;
  if (!family) {
    throw new DispatchError(
      'That model has no known family yet, so there is no workflow for it.',
      false,
    );
  }

  // Claim a backend before choosing the graph or compiling: which template
  // fits depends on where *this* backend has the file, and the filenames we
  // compile in are only correct for the backend that reported them.
  const backend = await pickBackend(job.params.modelId);
  const choice = await chooseTemplate({
    modelId: job.params.modelId,
    capability: job.params.kind,
    family,
    filename: model?.filename ?? null,
    info: await objectInfoFor(backend.base_url).catch(() => null),
  });
  if (!choice) {
    throw new DispatchError(`No ${job.params.kind} workflow exists for ${family} models.`, false);
  }
  const { template } = choice;

  const modelIds = [job.params.modelId, ...(job.params.loras ?? []).map((l) => l.modelId)];
  const modelFilenames = await filenamesOn(backend.id, modelIds);

  let compiled;
  try {
    compiled = compile({ params: job.params, template, modelFilenames, jobId: job.id });
  } catch (err) {
    // A validation error is the user's input; a template error is ours. Both
    // are permanent for this job — retrying changes nothing.
    if (err instanceof ValidationError || err instanceof TemplateError) {
      throw new DispatchError(err.message, false);
    }
    throw err;
  }

  // An img2img graph names a file on the *backend's* disk, which only exists
  // once we put it there. This has to happen after compiling (the graph must
  // exist to be pointed at) and before submitting (ComfyUI validates the path
  // when the prompt is queued, not when the node runs).
  let graph = compiled.graph;
  const storageKey = await initImageKey(job);
  if (storageKey) {
    try {
      const transferred = await sendStoredInitImageToBackend({
        backendUrl: backend.base_url,
        storageKey,
      });
      graph = withInitImage(graph, transferred.reference);
    } catch (err) {
      // The backend refusing an upload is usually transient — it is the same
      // machine we are about to ask to run the job.
      throw new DispatchError(
        `Could not send the reference image to ${backend.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        true,
      );
    }
  }

  // Last line of defence before the user starts waiting: a graph naming a file
  // this backend cannot load is refused here rather than by ComfyUI two minutes
  // later. `POST /jobs` already ran this against the same backend, but a job
  // may have sat in our queue while a model was removed, and dispatch is free
  // to choose a *different* backend than the one the route checked.
  const problem = await preflight(graph, backend);
  if (problem) throw new DispatchError(problem, false);

  // Companion models — a T5 text encoder, a standalone VAE — are named in the
  // graph as literals that were only ever a best guess at a filename. Resolve
  // them against what this backend actually reports before submitting, so a
  // user who installed *an* encoder gets theirs used rather than ours.
  // preflight awaits the same cached /object_info a few lines later, so this
  // costs nothing.
  const info = await objectInfoFor(backend.base_url).catch(() => null);
  if (info) graph = withResolvedRequirements(graph, template, info);

  const res = await fetch(`${backend.base_url}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    signal: AbortSignal.timeout(30_000),
  }).catch((err: unknown) => {
    throw new DispatchError(
      `Could not reach ${backend.name}: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new DispatchError(
      `${backend.name} rejected the workflow (${res.status}): ${body.slice(0, 400)}`,
      // A 5xx may pass; a 4xx means the graph itself is wrong and will not.
      res.status >= 500,
    );
  }

  const { prompt_id: promptId } = (await res.json()) as { prompt_id?: string };
  if (!promptId) {
    throw new DispatchError('The backend accepted the workflow but returned no prompt id.', true);
  }

  return {
    backend,
    promptId,
    templateId: template.manifest.id,
    resolved: compiled.resolved,
    nodeClasses: Object.fromEntries(
      Object.entries(graph).map(([nodeId, node]) => [nodeId, node.class_type]),
    ),
    modelLabel: model?.display_name ?? family,
  };
}
