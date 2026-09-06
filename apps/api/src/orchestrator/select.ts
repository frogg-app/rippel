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
 */
export async function pickBackend(modelId: Uuid): Promise<Candidate> {
  const candidates = await candidatesFor(modelId);
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
