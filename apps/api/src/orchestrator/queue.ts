/**
 * The shared queue: what is waiting, what is running, and who may see what.
 *
 * There is one GPU and several people, so the queue is a real object the whole
 * house looks at rather than an implementation detail of the dispatch loop.
 * Two rules shape everything here:
 *
 *  1. **The length of the queue is not private; what people typed into it is.**
 *     A non-admin sees every entry — position, owner, status — and the *params*
 *     of their own jobs only. That is enforced in the SELECT: a foreign row
 *     comes back from Postgres with `params` already null, so there is no
 *     moment at which this process holds somebody else's prompt in a variable
 *     and is trusted to delete it before replying.
 *  2. **One snapshot, one bucket.** The waiting jobs and the running one are
 *     read by a single statement, so a job that is being dispatched at that
 *     instant is seen exactly once — in whichever bucket its status put it —
 *     rather than twice from two queries or in neither.
 *
 * The db handle is an interface rather than an import, as in library/queries.ts,
 * so this is unit-testable without a live Postgres.
 */

import type { GenerationParams, QueueEntry, QueueJob, QueueView, Uuid } from '@comfy/shared';
import { query as defaultQuery, queryOne as defaultQueryOne } from '../db.js';
import { publish } from './events.js';
import { QUEUE_ORDER, toJob, type JobRow } from './jobs.js';

export interface QueueDb {
  query: typeof defaultQuery;
  queryOne: typeof defaultQueryOne;
}

export const realDb: QueueDb = { query: defaultQuery, queryOne: defaultQueryOne };

/**
 * Everything that has not finished. 'queued' is the queue proper; the other
 * three are a job the backend already has, which is what `running` reports.
 */
const LIVE_STATUSES = "('queued', 'dispatched', 'running', 'uploading')";

/** Every column of `jobs` except `params`, which is selected separately. */
const JOB_COLUMNS = `j.id, j.user_id, j.kind, j.status, j.template_id, j.backend_id,
                     j.comfy_prompt_id, j.progress, j.error, j.priority,
                     j.created_at, j.started_at, j.finished_at`;

/**
 * The privacy rule, as SQL.
 *
 * $1 is the viewer, $2 whether they are an admin. Written as a projection
 * rather than a filter applied afterwards so that the withholding cannot be
 * forgotten by a later caller: the row simply never carries the prompt.
 */
const VISIBLE_PARAMS = `CASE WHEN $2::boolean OR j.user_id = $1::uuid
                             THEN j.params ELSE NULL END AS params`;

export interface QueueRow extends Omit<JobRow, 'params'> {
  params: GenerationParams | null;
  priority: number;
  owner_name: string | null;
}

/**
 * A queue row as the shared `QueueJob`.
 *
 * `toJob` copies `params` straight through, so handing it the masked value is
 * what carries the withholding all the way out to the client; the cast is the
 * one place the two shapes meet, and it is immediately undone by the spread.
 */
function toQueueJob(row: QueueRow, queuePosition: number | null): QueueJob {
  return {
    ...toJob({ ...row, params: row.params as GenerationParams }),
    params: row.params,
    queuePosition,
    // Nothing in this view has finished, so nothing here has assets yet. Left
    // empty rather than joined: a queue read happens on every page that shows
    // the queue, and a join for rows that are always zero is pure cost.
    assets: [],
  };
}

function toEntry(row: QueueRow, position: number, queuePosition: number | null): QueueEntry {
  return {
    job: toQueueJob(row, queuePosition),
    position,
    ownerName: row.owner_name,
    ownerId: row.user_id,
  };
}

export interface QueueViewOptions {
  viewerId: Uuid;
  isAdmin: boolean;
  db?: QueueDb;
}

/**
 * The whole queue, from one viewer's point of view.
 *
 * Ordered exactly as the dispatch loop orders it — `QUEUE_ORDER`, shared with
 * `nextQueuedJob` so the positions shown are the positions that will happen,
 * not a second opinion about them.
 */
export async function loadQueueView({
  viewerId,
  isAdmin,
  db = realDb,
}: QueueViewOptions): Promise<QueueView> {
  const rows = await db.query<QueueRow>(
    `SELECT ${JOB_COLUMNS}, ${VISIBLE_PARAMS}, u.display_name AS owner_name
       FROM jobs j
       JOIN users u ON u.id = j.user_id
      WHERE j.status IN ${LIVE_STATUSES}
      ORDER BY j.${QUEUE_ORDER}`,
    [viewerId, isAdmin],
  );

  const queued = rows.filter((row) => row.status === 'queued');
  const active = rows.filter((row) => row.status !== 'queued');

  // Per-user positions come out of the same ordered pass rather than a count
  // query per row: it is the same number `queuePosition` computes, and this is
  // the one place we already have the whole queue in order.
  const aheadOf = new Map<string, number>();

  const entries = queued.map((row, index) => {
    const mine = aheadOf.get(row.user_id) ?? 0;
    aheadOf.set(row.user_id, mine + 1);
    // Global position is 1-based — "you are third" — while the per-user
    // queuePosition stays 0-based, as `Job` has always documented it.
    return toEntry(row, index + 1, mine);
  });

  // The runner dispatches one job at a time, so `active` normally holds exactly
  // one row. It can briefly hold more — a job still being stored while the next
  // one is dispatched, or several re-adopted after a restart — and the one on
  // the GPU is the one that started first.
  const running = [...active].sort(startedFirst)[0];

  return { entries, running: running ? toEntry(running, 0, null) : null };
}

function startedFirst(a: QueueRow, b: QueueRow): number {
  return (a.started_at ?? a.created_at).getTime() - (b.started_at ?? b.created_at).getTime();
}

/**
 * Put a queued job at the front.
 *
 * `max(priority) + 1` rather than a fixed constant, so two promotions do not
 * tie: the most recently promoted job goes first, which is what an admin doing
 * it twice means. Guarded by `status = 'queued'` in the WHERE clause, not by a
 * read beforehand — the dispatch loop runs every second and could take the job
 * between the two — so a job that has just started returns null and the route
 * says so instead of pretending it moved.
 */
export async function promoteToTop(id: Uuid, db: QueueDb = realDb): Promise<JobRow | null> {
  return db.queryOne<JobRow>(
    `UPDATE jobs
        SET priority = COALESCE((SELECT max(priority) FROM jobs WHERE status = 'queued'), 0) + 1
      WHERE id = $1 AND status = 'queued'
      RETURNING *`,
    [id],
  );
}

/**
 * Tell everyone with a job still waiting where it now sits.
 *
 * Promoting or cancelling one job moves every job behind it, and those belong
 * to other people. The event bus is per-user by construction, so the only way
 * to keep their tabs honest without polling is to publish a `job.status` per
 * queued job — an event that already exists and that clients already handle.
 * The queue is a handful of rows on one GPU; this is one query.
 */
export async function publishQueuePositions(db: QueueDb = realDb): Promise<void> {
  const rows = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM jobs WHERE status = 'queued' ORDER BY ${QUEUE_ORDER}`,
  );

  const aheadOf = new Map<string, number>();
  for (const row of rows) {
    const mine = aheadOf.get(row.user_id) ?? 0;
    aheadOf.set(row.user_id, mine + 1);
    publish(row.user_id, {
      type: 'job.status',
      jobId: row.id,
      status: 'queued',
      queuePosition: mine,
    });
  }
}
