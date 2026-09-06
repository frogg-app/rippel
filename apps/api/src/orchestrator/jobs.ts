/**
 * Job rows: reading, writing, and turning them into the shared `Job` shape.
 *
 * Status transitions all funnel through `setStatus` so that every one of them
 * publishes an event. A status change nobody is told about is the bug this
 * shape exists to prevent — it looks fine in the database and leaves the UI
 * showing a spinner forever.
 */

import type { GenerationParams, Job, JobProgress, JobStatus, Uuid } from '@comfy/shared';
import { query, queryOne } from '../db.js';
import { publish } from './events.js';

export interface JobRow {
  id: string;
  user_id: string;
  kind: string;
  status: JobStatus;
  params: GenerationParams;
  template_id: string | null;
  backend_id: string | null;
  comfy_prompt_id: string | null;
  progress: Partial<JobProgress>;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** A job that has not started has no meaningful progress; this is that. */
export const EMPTY_PROGRESS: JobProgress = {
  step: null,
  totalSteps: null,
  frame: null,
  totalFrames: null,
  fraction: 0,
  etaSeconds: null,
  previewUrl: null,
};

export function toJob(row: JobRow, assets: Job['assets'] = []): Job {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as Job['kind'],
    status: row.status,
    // Only meaningful while queued; computed by the caller that knows the queue.
    queuePosition: null,
    params: row.params,
    backendId: row.backend_id,
    progress: { ...EMPTY_PROGRESS, ...row.progress },
    error: row.error,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    assets,
  };
}

const TERMINAL: JobStatus[] = ['complete', 'failed', 'cancelled'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

export async function getJob(id: Uuid, userId?: Uuid): Promise<JobRow | null> {
  // When a userId is supplied it goes in the WHERE clause rather than being
  // checked afterwards, so another user's job is indistinguishable from one
  // that does not exist.
  return userId
    ? queryOne<JobRow>('SELECT * FROM jobs WHERE id = $1 AND user_id = $2', [id, userId])
    : queryOne<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
}

export async function createJob(
  userId: Uuid,
  params: GenerationParams,
  templateId: string,
): Promise<JobRow> {
  const row = await queryOne<JobRow>(
    `INSERT INTO jobs (user_id, kind, params, template_id, progress)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     RETURNING *`,
    [userId, params.kind, JSON.stringify(params), templateId],
  );
  return row!;
}

/**
 * Move a job to a new status and tell the user.
 *
 * `started_at` and `finished_at` are stamped here rather than by callers so
 * they cannot disagree, and a terminal status clears any stale progress the
 * job was carrying — a failed job showing "step 12 of 20" forever reads as if
 * it were still going.
 */
export async function setStatus(
  id: Uuid,
  status: JobStatus,
  extra: { error?: string | null; backendId?: Uuid | null; comfyPromptId?: string | null } = {},
): Promise<JobRow | null> {
  const row = await queryOne<JobRow>(
    `UPDATE jobs
        SET status = $2,
            error = COALESCE($3, error),
            backend_id = COALESCE($4, backend_id),
            comfy_prompt_id = COALESCE($5, comfy_prompt_id),
            started_at = COALESCE(started_at,
                                  CASE WHEN $2 IN ('dispatched','running') THEN now() END),
            finished_at = CASE WHEN $2 IN ('complete','failed','cancelled')
                               THEN now() ELSE finished_at END
      WHERE id = $1
      RETURNING *`,
    [id, status, extra.error ?? null, extra.backendId ?? null, extra.comfyPromptId ?? null],
  );
  if (!row) return null;

  publish(row.user_id, {
    type: 'job.status',
    jobId: row.id,
    status: row.status,
    queuePosition: status === 'queued' ? await queuePosition(row) : null,
  });
  return row;
}

export async function setProgress(row: JobRow, progress: JobProgress): Promise<void> {
  // Progress is written to the row so a reload or a reconnect shows the real
  // state rather than restarting at zero, and published for anyone watching.
  await query('UPDATE jobs SET progress = $2 WHERE id = $1', [row.id, JSON.stringify(progress)]);
  publish(row.user_id, { type: 'job.progress', jobId: row.id, progress });
}

export async function failJob(row: JobRow, error: string): Promise<void> {
  await setStatus(row.id, 'failed', { error });
  publish(row.user_id, { type: 'job.failed', jobId: row.id, error });
}

/**
 * How many of this user's jobs are ahead of this one. 0 means next.
 *
 * Deliberately per-user: with one shared GPU a global position would tell a
 * user how much other people are generating, which is neither their business
 * nor useful to them.
 */
export async function queuePosition(row: JobRow): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*) AS count
       FROM jobs
      WHERE user_id = $1 AND status = 'queued' AND created_at < $2`,
    [row.user_id, row.created_at],
  );
  return Number(rows[0]?.count ?? 0);
}

/** The oldest job still waiting, across all users. FIFO, no priorities yet. */
export async function nextQueuedJob(): Promise<JobRow | null> {
  const rows = await query<JobRow>(
    `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Jobs the orchestrator believes are in flight — used to reconcile on boot. */
export async function inFlightJobs(): Promise<JobRow[]> {
  return query<JobRow>(
    `SELECT * FROM jobs
      WHERE status IN ('dispatched', 'running', 'uploading')
      ORDER BY created_at`,
  );
}
