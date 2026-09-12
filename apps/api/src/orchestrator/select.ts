/**
 * Choosing which backend runs a job.
 *
 * The constraint that actually matters is possession: a backend can only run a
 * job if it has the model file on disk. Everything else — capacity, fairness,
 * VRAM — is a preference among backends that *could* run it. Getting this
 * order wrong produces the worst failure mode available to us, which is
 * dispatching to a backend that then fails at the checkpoint loader after the
 * user has already been told their job started.
 */

import type { Uuid } from '@comfy/shared';
import { query } from '../db.js';
import { assessOn } from './fit.js';

export interface Candidate {
  id: string;
  name: string;
  base_url: string;
  /** The filename ComfyUI addresses the model by, subfolder and all. */
  filename: string;
  active_jobs: number;
}

export class NoBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoBackendError';
  }
}

/**
 * Backends that are online, enabled, and hold this model.
 *
 * Note that `models` is keyed `(type, filename)` across the whole fleet, so the
 * filename is a property of the model rather than of the pairing: a backend
 * that stores the same weights under a different path (`SDXL/foo.safetensors`
 * vs `foo.safetensors`) reports a different filename and therefore becomes a
 * *different* model row, which `model_backends` simply never links to this one.
 * That is a little wasteful and entirely correct — we would rather have two
 * rows than dispatch a job naming a path the chosen backend cannot resolve.
 */
export async function candidatesFor(modelId: Uuid): Promise<Candidate[]> {
  return query<Candidate>(
    `SELECT b.id, b.name, b.base_url, m.filename,
            count(j.id) FILTER (
              WHERE j.status IN ('dispatched', 'running', 'uploading')
            ) AS active_jobs
       FROM backends b
       JOIN model_backends mb ON mb.backend_id = b.id
       JOIN models m ON m.id = mb.model_id
       LEFT JOIN jobs j ON j.backend_id = b.id
      WHERE mb.model_id = $1
        AND b.enabled
        AND b.status = 'online'
      GROUP BY b.id, m.filename
      ORDER BY active_jobs ASC, b.name ASC`,
    [modelId],
  );
}

/**
 * Pick one. Least-loaded first, ties broken by name so the choice is stable
 * and therefore reproducible when something goes wrong.
 *
 * Deliberately not weighted by reported VRAM: that figure is a budget rather
 * than a physical size and, as this project learned the hard way, may not even
 * describe the card you meant. Job counts are something we measure ourselves.
 *
 * It *is* weighted by what each machine has actually run, when a score is
 * supplied. That is a different claim from the VRAM one and rests on different
 * evidence — not what the driver says it has, but what we have watched it
 * finish. A machine that has already run out of memory on a job this size drops
 * behind one that has not, which on a mixed fleet is the whole difference
 * between a 14B clip landing on the 24 GB card and landing on the 16 GB one.
 *
 * Crucially it only ever *reorders*. A backend known to be too small is still a
 * candidate, last, because the alternative is refusing a job that the ledger is
 * merely pessimistic about — the brackets come from history, and history is not
 * a promise. Possession still decides who is eligible at all.
 */
export async function pickBackend(modelId: Uuid, score?: number): Promise<Candidate> {
  const candidates = await rankByFit(await candidatesFor(modelId), score);
  const chosen = candidates[0];

  if (!chosen) {
    // Distinguish "nowhere has it" from "the places that have it are down",
    // because the two need completely different actions from an operator.
    const anywhere = await query<{ name: string; status: string; enabled: boolean }>(
      `SELECT b.name, b.status, b.enabled
         FROM backends b JOIN model_backends mb ON mb.backend_id = b.id
        WHERE mb.model_id = $1`,
      [modelId],
    );

    throw new NoBackendError(
      anywhere.length === 0
        ? 'No backend has this model installed.'
        : `The backend${anywhere.length > 1 ? 's' : ''} holding this model ${
            anywhere.length > 1 ? 'are' : 'is'
          } not available right now.`,
    );
  }

  return chosen;
}

/** Filenames for every model a job needs, on one backend: checkpoint + LoRAs. */
export async function filenamesOn(
  backendId: Uuid,
  modelIds: Uuid[],
): Promise<Record<Uuid, string>> {
  if (modelIds.length === 0) return {};

  const rows = await query<{ model_id: string; filename: string }>(
    `SELECT mb.model_id, m.filename
       FROM model_backends mb
       JOIN models m ON m.id = mb.model_id
      WHERE mb.backend_id = $1 AND mb.model_id = ANY($2::uuid[])`,
    [backendId, modelIds],
  );

  return Object.fromEntries(rows.map((r) => [r.model_id, r.filename]));
}

/**
 * Bytes on disk for every model a job loads, on one backend.
 *
 * Separate from `filenamesOn` because the two have different failure modes and
 * only one of them is fatal. A filename we cannot resolve stops the job — we
 * would be naming a path the backend cannot open. A *size* we cannot resolve is
 * merely a less precise score, so a missing row is a `null` here rather than an
 * absent key, and `cost.ts` folds it into `partial`.
 *
 * `size_bytes` is nullable on `models` for anything discovered by scanning a
 * folder rather than downloaded through the catalogue, which on a
 * hand-populated machine is most of them. That is the common case, not an edge.
 */
export async function sizesOn(
  backendId: Uuid,
  modelIds: Uuid[],
): Promise<Record<Uuid, number | null>> {
  if (modelIds.length === 0) return {};

  const rows = await query<{ model_id: string; size_bytes: string | null }>(
    `SELECT mb.model_id, m.size_bytes
       FROM model_backends mb
       JOIN models m ON m.id = mb.model_id
      WHERE mb.backend_id = $1 AND mb.model_id = ANY($2::uuid[])`,
    [backendId, modelIds],
  );

  return Object.fromEntries(
    rows.map((r) => [r.model_id, r.size_bytes === null ? null : Number(r.size_bytes)]),
  );
}

/**
 * Move backends that have already failed a job this size to the back.
 *
 * Stable within each group, so the least-loaded ordering `candidatesFor`
 * established survives inside both halves and the choice stays reproducible.
 * With no score, or on a fleet of one, this is the identity.
 */
async function rankByFit(candidates: Candidate[], score?: number): Promise<Candidate[]> {
  if (score === undefined || candidates.length < 2) return candidates;

  const verdicts = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return (await assessOn(candidate.id, score)).verdict;
      } catch {
        // A machine we cannot assess is not a machine we demote.
        return 'unknown' as const;
      }
    }),
  );

  const fine: Candidate[] = [];
  const doubtful: Candidate[] = [];
  candidates.forEach((candidate, i) => {
    (verdicts[i] === 'too-big' ? doubtful : fine).push(candidate);
  });
  return [...fine, ...doubtful];
}

/**
 * Bytes on disk for these models, regardless of which backend holds them.
 *
 * `sizesOn` answers the same question for one backend and is the right call
 * once a backend is chosen. This one exists for the moment *before* that, when
 * the size is wanted precisely in order to choose. A size is a property of the
 * file rather than of the machine, so no join is needed and none is done.
 */
export async function modelSizes(modelIds: Uuid[]): Promise<(number | null)[]> {
  if (modelIds.length === 0) return [];
  const rows = await query<{ id: string; size_bytes: string | null }>(
    'SELECT id, size_bytes FROM models WHERE id = ANY($1::uuid[])',
    [modelIds],
  );
  const byId = new Map(rows.map((r) => [r.id, r.size_bytes === null ? null : Number(r.size_bytes)]));
  // Preserve the caller's order, and keep a model we know nothing about as a
  // null rather than dropping it — `cost.ts` folds that into `partial`.
  return modelIds.map((id) => byId.get(id) ?? null);
}
