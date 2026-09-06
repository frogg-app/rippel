/**
 * The model install service.
 *
 * The one non-obvious rule here: a transport saying "done" is never enough to
 * mark an install complete. What we actually care about is whether ComfyUI can
 * *see* the file, because that is the precondition for a job being able to use
 * it — a download that landed in the wrong folder, or landed fine but needs a
 * ComfyUI restart before it appears in `/object_info`, is not usable yet and
 * must not be reported as ready. So completion is decided by polling ComfyUI's
 * own model listing for the filename, and the transport's queue state only
 * tells us whether to keep waiting.
 */

import type { ModelInstall, ModelInstallStatus, ModelType, Uuid } from '@comfy/shared';
import { query, queryOne } from '../db.js';
import { ComfyClient } from '../lib/comfy.js';
import { ComfyManagerTransport } from './transports/comfy-manager.js';
import type { InstallRequest, ModelTransport } from './transport.js';
import { TransportError, TransportUnavailable } from './transport.js';

export interface InstallRow {
  id: string;
  backend_id: string;
  requested_by: string;
  filename: string;
  display_name: string;
  model_type: string;
  base_model: string;
  url: string;
  save_path: string;
  status: ModelInstallStatus;
  detail: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export function toModelInstall(row: InstallRow): ModelInstall {
  return {
    id: row.id,
    backendId: row.backend_id,
    requestedBy: row.requested_by,
    filename: row.filename,
    displayName: row.display_name,
    type: row.model_type as ModelType,
    base: row.base_model,
    url: row.url,
    status: row.status,
    detail: row.detail,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

/**
 * Which transport a backend has.
 *
 * Only one exists today. It is resolved per call rather than cached because a
 * backend gains or loses the capability when someone installs Manager and
 * restarts ComfyUI, and a cache would report the stale answer for as long as
 * the API happened to stay up.
 */
export function transportFor(baseUrl: string): ModelTransport {
  return new ComfyManagerTransport(baseUrl);
}

export async function requireTransport(baseUrl: string): Promise<ModelTransport> {
  const transport = transportFor(baseUrl);
  if (!(await transport.available())) {
    throw new TransportUnavailable(
      'This backend cannot install models: ComfyUI-Manager is not responding on it. ' +
        'Install ComfyUI-Manager into the backend\'s custom_nodes and restart ComfyUI.',
    );
  }
  return transport;
}

/** The request we hand the transport, rebuilt from a stored row. */
export function requestFromRow(row: InstallRow): InstallRequest {
  return {
    name: row.display_name,
    filename: row.filename,
    type: row.model_type,
    base: row.base_model,
    savePath: row.save_path,
    url: row.url,
  };
}

/**
 * Does ComfyUI itself list this file yet?
 *
 * `/api/models/<folder>` is the cheapest authoritative answer — far cheaper
 * than `/object_info`, which serialises every node's full input spec and is
 * megabytes on a busy install. Filenames come back including any subfolder
 * ("SDXL\\sd_xl_base_1.0.safetensors"), and on a Windows backend that separator
 * is a backslash, so matching is on the basename.
 */
export async function backendHasFile(
  baseUrl: string,
  folder: string,
  filename: string,
): Promise<boolean> {
  const res = await fetch(`${baseUrl}/api/models/${folder}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return false;

  const files = (await res.json()) as unknown;
  if (!Array.isArray(files)) return false;

  const target = basename(filename);
  return files.some((f) => typeof f === 'string' && basename(f) === target);
}

/** Last path segment, for either separator — the backend may be Windows. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Our model type -> the ComfyUI folder name that holds it. */
const FOLDER_FOR_TYPE: Record<string, string> = {
  checkpoint: 'checkpoints',
  lora: 'loras',
  vae: 'vae',
  controlnet: 'controlnet',
  upscaler: 'upscale_models',
  clip: 'text_encoders',
};

export function folderForType(type: string): string | null {
  return FOLDER_FOR_TYPE[type] ?? null;
}

/**
 * Advance one in-flight install.
 *
 * Called on a timer. Deliberately does the cheap authoritative check first: if
 * ComfyUI can already see the file we are done regardless of what the queue
 * says, which also covers the case where the API was restarted mid-download and
 * missed the transition entirely.
 */
export async function refreshInstall(row: InstallRow, baseUrl: string): Promise<ModelInstall> {
  const folder = folderForType(row.model_type);

  if (folder) {
    try {
      if (await backendHasFile(baseUrl, folder, row.filename)) {
        return finish(row.id, 'complete', 'Installed and visible to ComfyUI');
      }
    } catch {
      // The backend being unreachable is not an install failure; the next tick
      // will try again. Falling through to the queue check would only produce a
      // second error from the same cause.
      return toModelInstall(row);
    }
  }

  let progress;
  try {
    progress = await transportFor(baseUrl).progress(requestFromRow(row));
  } catch (err) {
    if (err instanceof TransportError && err.retryable) return toModelInstall(row);
    return fail(row.id, err instanceof Error ? err.message : String(err));
  }

  if (progress.state === 'failed') {
    return fail(row.id, progress.error ?? 'The backend reported the download failed');
  }

  const status: ModelInstallStatus = progress.state === 'downloading' ? 'downloading' : 'queued';
  const rows = await query<InstallRow>(
    `UPDATE model_installs
        SET status = $2,
            detail = $3,
            started_at = COALESCE(started_at, CASE WHEN $2 = 'downloading' THEN now() END)
      WHERE id = $1
      RETURNING *`,
    [row.id, status, progress.detail],
  );
  return toModelInstall(rows[0] ?? row);
}

async function finish(id: string, status: ModelInstallStatus, detail: string): Promise<ModelInstall> {
  const row = await queryOne<InstallRow>(
    `UPDATE model_installs
        SET status = $2, detail = $3, finished_at = now(), error = NULL
      WHERE id = $1
      RETURNING *`,
    [id, status, detail],
  );
  return toModelInstall(row!);
}

async function fail(id: string, error: string): Promise<ModelInstall> {
  const row = await queryOne<InstallRow>(
    `UPDATE model_installs
        SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, error],
  );
  return toModelInstall(row!);
}

/** Every install still in flight, with the backend URL needed to poll it. */
export async function activeInstalls(): Promise<(InstallRow & { base_url: string })[]> {
  return query<InstallRow & { base_url: string }>(
    `SELECT mi.*, b.base_url
       FROM model_installs mi
       JOIN backends b ON b.id = mi.backend_id
      WHERE mi.status IN ('queued', 'downloading')
      ORDER BY mi.created_at`,
  );
}

export async function createInstall(params: {
  backendId: Uuid;
  requestedBy: Uuid;
  entry: { name: string; filename: string; type: ModelType; base: string; url: string; ref: string };
}): Promise<InstallRow> {
  // The catalogue ref is "<save_path>/<filename>" — the exact tuple the
  // transport's whitelist matches on. Splitting it back out here keeps the
  // save_path out of the API surface while preserving it for the request.
  const savePath = params.entry.ref.slice(0, params.entry.ref.lastIndexOf('/'));

  const row = await queryOne<InstallRow>(
    `INSERT INTO model_installs
       (backend_id, requested_by, filename, display_name, model_type, base_model, url, save_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      params.backendId,
      params.requestedBy,
      params.entry.filename,
      params.entry.name,
      params.entry.type,
      params.entry.base,
      params.entry.url,
      savePath,
    ],
  );
  return row!;
}
