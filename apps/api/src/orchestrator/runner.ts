/**
 * The orchestrator loop.
 *
 * One job at a time per backend, driven by a timer rather than by the socket.
 * That is the important design decision here: the socket makes progress feel
 * live, but it is never load-bearing. Every state this loop can be in is
 * recoverable from the database plus `/history`, so an API restart mid-job, a
 * dropped connection, or a backend that reboots all converge back to the truth
 * on the next tick instead of stranding a job as "running" forever.
 *
 * The failure this is built to avoid: a user watching a spinner for a job that
 * finished, failed, or was never submitted.
 */

import { randomUUID } from 'node:crypto';
import type { Job, JobProgress } from '@comfy/shared';
import { query } from '../db.js';
import { publish } from './events.js';
import { collectOutputs, readHistory } from './collect.js';
import { rowToAsset, type AssetRow } from '../storage/persist.js';
import { ComfySocket } from './comfy-socket.js';
import { dispatch, DispatchError } from './dispatch.js';
import { NoBackendError } from './select.js';
import {
  EMPTY_PROGRESS,
  failJob,
  getJob,
  inFlightJobs,
  nextQueuedJob,
  setProgress,
  setStatus,
  toJob,
  type JobRow,
} from './jobs.js';

const TICK_MS = 1_000;

/**
 * How long a dispatched job may go missing from /history before we give up.
 *
 * This is the "backend restarted and forgot" case: ComfyUI only writes a
 * history entry when execution ends, so a prompt it lost leaves no trace at
 * all. Without a ceiling such a job stays 'running' forever.
 */
const MISSING_TIMEOUT_MS = 10 * 60 * 1000;

interface Tracked {
  jobId: string;
  userId: string;
  promptId: string;
  backendUrl: string;
  dispatchedAt: number;
  /** Steps seen so far, for an ETA that is measured rather than guessed. */
  firstStepAt: number | null;
}

export function startOrchestrator(log: (msg: string) => void = console.log): () => void {
  const clientId = randomUUID();
  const sockets = new Map<string, ComfySocket>();
  const tracked = new Map<string, Tracked>(); // by ComfyUI prompt id
  let stopped = false;
  let ticking = false;

  /** Attach to a backend's socket once, and keep it. */
  function socketFor(baseUrl: string): void {
    if (sockets.has(baseUrl)) return;

    const socket = new ComfySocket(
      baseUrl,
      clientId,
      {
        onProgress: (promptId, progress) => {
          const entry = tracked.get(promptId);
          if (!entry) return;

          const now = Date.now();
          entry.firstStepAt ??= now;

          // ETA from the rate we have actually observed on this job. A number
          // derived from step counts alone would be wrong on every backend.
          const elapsed = now - entry.firstStepAt;
          const remaining = progress.max - progress.value;
          const etaSeconds =
            progress.value > 0 && elapsed > 0
              ? Math.round((elapsed / progress.value) * remaining / 1000)
              : null;

          void applyProgress(entry, {
            ...EMPTY_PROGRESS,
            step: progress.value,
            totalSteps: progress.max,
            fraction: progress.max > 0 ? progress.value / progress.max : 0,
            etaSeconds,
          });
        },

        onPreview: (promptId, image, mimeType) => {
          const entry = tracked.get(promptId);
          if (!entry) return;
          // Previews are pushed straight through as a data URL rather than
          // stored: they are superseded within a second and only matter to a
          // tab that is watching right now.
          publish(entry.userId, {
            type: 'job.progress',
            jobId: entry.jobId,
            progress: {
              ...EMPTY_PROGRESS,
              previewUrl: `data:${mimeType};base64,${image.toString('base64')}`,
            },
          });
        },

        onError: (promptId, message) => {
          const entry = tracked.get(promptId);
          if (!entry) return;
          // Do not fail the job from the socket alone — /history is the
          // authority and the next tick will read it. Recording the message
          // here just means the user sees it a second earlier.
          log(`[orchestrator] ${entry.jobId} reported an error: ${message}`);
        },

        onDone: () => {
          // Nothing to do: the tick reads /history, which is what decides.
        },
      },
      log,
    );

    socket.connect();
    sockets.set(baseUrl, socket);
  }

  async function applyProgress(entry: Tracked, progress: JobProgress): Promise<void> {
    const row = await getJob(entry.jobId);
    if (!row) return;
    // First real progress means it is genuinely running, not merely queued on
    // the backend.
    if (row.status === 'dispatched') await setStatus(row.id, 'running');
    await setProgress(row, progress);
  }

  /** Send one queued job to a backend. */
  async function dispatchNext(): Promise<void> {
    const job = await nextQueuedJob();
    if (!job) return;

    try {
      const result = await dispatch(job, clientId);

      await setStatus(job.id, 'dispatched', {
        backendId: result.backend.id,
        comfyPromptId: result.promptId,
      });
      await query('UPDATE jobs SET template_id = $2 WHERE id = $1', [job.id, result.templateId]);

      tracked.set(result.promptId, {
        jobId: job.id,
        userId: job.user_id,
        promptId: result.promptId,
        backendUrl: result.backend.base_url,
        dispatchedAt: Date.now(),
        firstStepAt: null,
      });
      socketFor(result.backend.base_url);

      log(`[orchestrator] ${job.id} -> ${result.backend.name} as ${result.promptId}`);
    } catch (err) {
      if (err instanceof NoBackendError || (err instanceof DispatchError && !err.retryable)) {
        await failJob(job, err.message);
        return;
      }
      // Retryable: leave it queued and try again next tick. Logged rather than
      // surfaced, because a backend being briefly unreachable is not news the
      // user can act on.
      log(`[orchestrator] ${job.id} deferred: ${String(err)}`);
    }
  }

  /** Ask /history what became of everything we think is in flight. */
  async function reconcile(): Promise<void> {
    const rows = await inFlightJobs();

    for (const row of rows) {
      if (!row.comfy_prompt_id || !row.backend_id) continue;

      const backend = await query<{ base_url: string }>(
        'SELECT base_url FROM backends WHERE id = $1',
        [row.backend_id],
      );
      const baseUrl = backend[0]?.base_url;
      if (!baseUrl) continue;

      // Re-adopt jobs this process never dispatched — the restart case.
      if (!tracked.has(row.comfy_prompt_id)) {
        tracked.set(row.comfy_prompt_id, {
          jobId: row.id,
          userId: row.user_id,
          promptId: row.comfy_prompt_id,
          backendUrl: baseUrl,
          dispatchedAt: row.started_at?.getTime() ?? Date.now(),
          firstStepAt: null,
        });
        socketFor(baseUrl);
      }

      await settle(row, baseUrl);
    }
  }

  /** Decide a single in-flight job from /history. */
  async function settle(row: JobRow, baseUrl: string): Promise<void> {
    const promptId = row.comfy_prompt_id!;
    let outcome;
    try {
      outcome = await readHistory(baseUrl, promptId);
    } catch {
      return; // Backend unreachable; try again next tick.
    }

    if (outcome.state === 'pending') {
      const entry = tracked.get(promptId);
      const since = entry?.dispatchedAt ?? row.started_at?.getTime() ?? Date.now();
      if (Date.now() - since > MISSING_TIMEOUT_MS) {
        tracked.delete(promptId);
        await failJob(
          row,
          'The backend has no record of this job. It was most likely restarted while the job was queued.',
        );
      }
      return;
    }

    if (outcome.state === 'error') {
      tracked.delete(promptId);
      await failJob(row, outcome.message);
      return;
    }

    // Success. Downloading is the slow part, so the job says so while it runs —
    // 'uploading' is our word for "generated, now being stored".
    if (row.status !== 'uploading') await setStatus(row.id, 'uploading');

    try {
      const assets = await collectOutputs({
        userId: row.user_id,
        jobId: row.id,
        backendUrl: baseUrl,
        outputs: outcome.outputs,
      });

      tracked.delete(promptId);
      await setStatus(row.id, 'complete');
      publish(row.user_id, { type: 'job.complete', jobId: row.id, assets });
      log(`[orchestrator] ${row.id} complete, ${assets.length} asset(s)`);
    } catch (err) {
      // The images exist on the backend; only our copy failed. Leaving the job
      // in 'uploading' lets the next tick retry, and fetchAndPersist's
      // idempotency means a partial success is not duplicated.
      log(`[orchestrator] ${row.id} could not store outputs: ${String(err)}`);
    }
  }

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await reconcile();
      await dispatchNext();
    } catch (err) {
      log(`[orchestrator] tick failed: ${String(err)}`);
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
    for (const socket of sockets.values()) socket.close();
    sockets.clear();
  };
}

/**
 * A job with its assets attached, for the routes.
 *
 * Reuses storage's own `rowToAsset` rather than mapping columns again here —
 * it is the thing that knows how a stored row becomes the shared `Asset`,
 * including how the URLs are derived, and a second copy of that would drift.
 */
export async function jobWithAssets(row: JobRow): Promise<Job> {
  const rows = await query<AssetRow>(
    `SELECT * FROM assets
      WHERE job_id = $1 AND deleted_at IS NULL
      ORDER BY created_at`,
    [row.id],
  );
  return toJob(row, rows.map(rowToAsset));
}
