/**
 * Cancelling a job — the single implementation of it.
 *
 * There are two routes that cancel (`POST /jobs/:id/cancel`, owner or admin,
 * and `DELETE /queue/:id`, admin) and they must not disagree about what
 * cancelling means, so they both come through here.
 *
 * The two cases are genuinely different:
 *
 *  - A **queued** job is ours. Nobody else has heard of it, so setting the
 *    status is the whole operation.
 *  - A **dispatched** job belongs to ComfyUI, and its own queue is the only
 *    thing that can stop it. We ask it to, and then mark the job cancelled
 *    *regardless of the answer*: a user who has disowned a job must not be left
 *    watching it because the backend happened to be unreachable. The GPU may
 *    finish the picture; nobody is waiting for it, and the next reconcile pass
 *    finds a cancelled row and lets it go.
 */

import type { JobStatus, Uuid } from '@comfy/shared';
import { queryOne as defaultQueryOne } from '../db.js';
import { isTerminal, setStatus as defaultSetStatus, type JobRow } from './jobs.js';

export interface CancelDeps {
  queryOne: typeof defaultQueryOne;
  setStatus: typeof defaultSetStatus;
  /** Injected so a test can assert we asked the backend, without a backend. */
  fetch: typeof globalThis.fetch;
}

export const realCancelDeps: CancelDeps = {
  queryOne: defaultQueryOne,
  setStatus: defaultSetStatus,
  fetch: (...args) => globalThis.fetch(...args),
};

/** How long we will wait for a backend to acknowledge a cancellation. */
const BACKEND_TIMEOUT_MS = 10_000;

/**
 * Cancel a job, whatever state it is in. Returns the row as it now stands.
 *
 * Terminal jobs are returned untouched rather than refused: cancelling
 * something that has already finished is a race, not an error, and the honest
 * answer is the job's real state.
 */
export async function cancelJob(row: JobRow, deps: CancelDeps = realCancelDeps): Promise<JobRow> {
  if (isTerminal(row.status as JobStatus)) return row;

  if (row.comfy_prompt_id && row.backend_id) {
    await askBackendToDrop(row.backend_id, row.comfy_prompt_id, deps);
  }

  // `setStatus` is what publishes `job.status` to the owner's open tabs, which
  // is why cancelling never writes the row directly.
  return (await deps.setStatus(row.id, 'cancelled')) ?? row;
}

async function askBackendToDrop(
  backendId: Uuid,
  promptId: string,
  deps: CancelDeps,
): Promise<void> {
  const backend = await deps.queryOne<{ base_url: string }>(
    'SELECT base_url FROM backends WHERE id = $1',
    [backendId],
  );
  if (!backend) return;

  await deps
    .fetch(`${backend.base_url}/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    })
    .catch(() => {
      // Best effort, deliberately. An unreachable backend must not leave the
      // job stuck: the cancellation below happens either way.
    });
}
