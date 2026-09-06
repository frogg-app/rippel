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
import type { ResolvedValues } from '../compiler/index.js';
import { findTemplate } from '../workflows/registry.js';
import { queryOne } from '../db.js';
import { filenamesOn, pickBackend, type Candidate } from './select.js';
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

/** The model family a job's checkpoint belongs to, for template lookup. */
async function familyOf(modelId: Uuid): Promise<string | null> {
  const row = await queryOne<{ base_model: string | null }>(
    'SELECT base_model FROM models WHERE id = $1',
    [modelId],
  );
  return row?.base_model ?? null;
}

export interface Dispatched {
  backend: Candidate;
  promptId: string;
  templateId: string;
  /** Everything the compiler decided, recorded so the job can be reproduced. */
  resolved: ResolvedValues;
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
  const family = await familyOf(job.params.modelId);
  if (!family) {
    throw new DispatchError(
      'That model has no known family yet, so there is no workflow for it.',
      false,
    );
  }

  const template = findTemplate(job.params.kind, family);
  if (!template) {
    throw new DispatchError(`No ${job.params.kind} workflow exists for ${family} models.`, false);
  }

  // Claim a backend before compiling, because the filenames we compile into the
  // graph are only correct for the backend that reported them.
  const backend = await pickBackend(job.params.modelId);
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
  };
}
