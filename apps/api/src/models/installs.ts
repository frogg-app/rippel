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

import type {
  ModelCatalogEntry,
  ModelInstall,
  ModelInstallStatus,
  ModelType,
  Uuid,
} from '@comfy/shared';
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
  /** bigint, so node-postgres hands these back as strings. See `bigintOrNull`. */
  bytes_total: string | number | null;
  bytes_received: string | number | null;
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
    bytesReceived: bigintOrNull(row.bytes_received),
    bytesTotal: bigintOrNull(row.bytes_total),
  };
}

/**
 * A `bigint` column as a number, or null.
 *
 * node-postgres returns bigint as a *string* rather than a number, because a
 * bigint can exceed what a double represents exactly. These particular bigints
 * cannot: the largest model anyone will ever download is a few hundred
 * gigabytes, and `Number.MAX_SAFE_INTEGER` is nine petabytes. So the conversion
 * is safe here, and doing it once at the boundary keeps `"6938078334"` out of
 * the API, where a client would concatenate it to something by accident.
 */
function bigintOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
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
    folder: folderForRow(row),
  };
}

/**
 * Which ComfyUI model folder this install lands in.
 *
 * The save_path is the better answer when it has one, because it is what the
 * download actually obeys: "loras/ltxv/ltx2" puts the file under `loras`, in a
 * nested directory ComfyUI still lists. Only the first segment matters, since
 * that is the folder ComfyUI names.
 *
 * Manager writes the literal string "default" when it means "wherever this type
 * normally goes" (19 of the 372 entries we surface), and that is the case the
 * type mapping exists for. Anything else unrecognised — `xlabs`, say, which is
 * a custom node's own directory and not a ComfyUI model folder at all — is
 * returned as-is and simply fails to list, which costs us the byte measurement
 * and nothing else.
 */
export function folderForRow(row: InstallRow): string | null {
  const first = row.save_path.split(/[\\/]/).find((seg) => seg && seg !== '.');
  if (first && first !== 'default') return first;
  return folderForType(row.model_type);
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
  const files = await listBackendFolder(baseUrl, folder);
  if (!files) return false;

  const target = basename(filename);
  return files.some((f) => basename(f) === target);
}

/**
 * The files in one of ComfyUI's model folders, or `null` when the folder does
 * not exist on that backend (a stock install has no `unet/`, and asking for one
 * is a 404 rather than an empty list).
 *
 * Extracted from `backendHasFile` so the readiness check can ask the *other*
 * question — not "is my file here" but "where on this machine is it?" — without
 * a second copy of the listing call. Deliberately not cached: it is a few
 * hundred bytes, and the whole point of a readiness screen is that it tells the
 * truth about the moment you asked.
 */
export async function listBackendFolder(
  baseUrl: string,
  folder: string,
): Promise<string[] | null> {
  const res = await fetch(`${baseUrl}/api/models/${folder}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;

  const files = (await res.json()) as unknown;
  if (!Array.isArray(files)) return null;
  return files.filter((f): f is string => typeof f === 'string');
}

/**
 * Which model folders this backend actually has. `GET /api/models` with no
 * folder returns the list, which is how we avoid 404ing our way through a scan
 * for a file that could be anywhere.
 */
export async function listBackendFolders(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/models`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const folders = (await res.json()) as unknown;
  if (!Array.isArray(folders)) return [];
  return folders.filter((f): f is string => typeof f === 'string');
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
 * The completion rule is subtler than it looks, and the obvious version is
 * wrong. ComfyUI-Manager downloads *in place* rather than to a temporary name,
 * and ComfyUI lists whatever is in the folder — so the file appears in
 * `/api/models/checkpoints` within seconds of the download starting and stays
 * there, half-written, for the next twenty minutes. Presence alone therefore
 * proves nothing, and treating it as proof marks a 7 GB download complete when
 * roughly none of it has arrived. (Observed against the real backend: the file
 * was listed while Manager still reported `is_processing: true`.)
 *
 * So both signals are required: Manager's queue must be idle *and* ComfyUI must
 * be able to see the file. The queue is checked first because it is the one
 * that can veto.
 */
export async function refreshInstall(row: InstallRow, baseUrl: string): Promise<ModelInstall> {
  let progress;
  try {
    progress = await transportFor(baseUrl).progress(requestFromRow(row));
  } catch (err) {
    // Unreachable is not failed: the next tick tries again. Only a definite,
    // non-retryable answer from the transport ends an install.
    if (err instanceof TransportError && err.retryable) return toModelInstall(row);
    return fail(row.id, err instanceof Error ? err.message : String(err));
  }

  if (progress.state === 'failed') {
    return fail(row.id, progress.error ?? 'The backend reported the download failed');
  }

  // Fold in the measurement before any decision is taken, so whatever this tick
  // concludes is stored alongside the byte count that justified it.
  //
  // `undefined` means the transport did not measure and the previous figure
  // stands; `null` means it measured and found nothing, which is also worth
  // recording — a file that has vanished is news. The count never goes
  // backwards on a live install, because the only ways it can are a transport
  // that briefly could not read the folder and a listing that raced the first
  // chunk, and neither is a real regression to show a human.
  const measured = progress.bytesReceived;
  const previous = bigintOrNull(row.bytes_received);
  const bytesReceived =
    measured === undefined
      ? previous
      : measured === null
        ? previous
        : previous === null
          ? measured
          : Math.max(previous, measured);

  const bytesTotal = bigintOrNull(row.bytes_total);

  // The one thing the byte count is allowed to *decide* rather than merely
  // describe: a file whose size on disk has reached the exact Content-Length of
  // its download is completely written. Nothing about Manager's queue can
  // improve on that, and quite a lot about Manager's queue can be wrong about
  // it — its in-progress set leaks entries when a worker thread dies, which on
  // the live backend has left the queue permanently "busy" and would otherwise
  // hold every subsequent install at 'downloading' for ever.
  //
  // Both halves are required. `bytesTotal` is only ever an exact
  // `Content-Length`, never the catalogue's rounded size, so equality here is
  // equality and not a threshold; and ComfyUI must still list the file, because
  // being fully written is not the same as being usable.
  const fullyWritten =
    bytesTotal !== null && bytesReceived !== null && bytesReceived >= bytesTotal;

  if (fullyWritten) {
    const folder = folderForType(row.model_type);
    try {
      if (folder && (await backendHasFile(baseUrl, folder, row.filename))) {
        return finish(row.id, 'complete', 'Installed and visible to ComfyUI', bytesReceived);
      }
    } catch {
      // Unreachable: leave it in flight and try again next tick.
      return toModelInstall(row);
    }
  }

  // Manager's queue is global rather than per-task, so a busy queue may be
  // working on somebody else's download while ours has already finished. That
  // makes this conservative — an install can sit in 'downloading' until the
  // whole queue drains — which is the right way to be wrong: reporting a
  // half-written checkpoint as ready would hand it to the job scheduler.
  if (progress.state === 'downloading') {
    return update(row, 'downloading', progress.detail, bytesReceived);
  }

  const folder = folderForType(row.model_type);
  if (folder) {
    try {
      if (await backendHasFile(baseUrl, folder, row.filename)) {
        return finish(row.id, 'complete', 'Installed and visible to ComfyUI', bytesReceived);
      }
    } catch {
      // Backend unreachable; try again next tick rather than inventing a state.
      return toModelInstall(row);
    }

    // An idle queue with no file means the download never produced anything —
    // Manager logs its own failures to its console and does not expose them
    // over HTTP, so this is as specific as we can honestly be.
    if (row.status === 'downloading') {
      return fail(
        row.id,
        'The backend finished its install queue but the file is not present. ' +
          "Check ComfyUI-Manager's console output on the backend for the reason.",
      );
    }
  }

  return update(row, 'queued', progress.detail, bytesReceived);
}

/** Write back a still-in-flight state, stamping started_at on the first move. */
async function update(
  row: InstallRow,
  status: ModelInstallStatus,
  detail: string | null,
  bytesReceived: number | null,
): Promise<ModelInstall> {
  const rows = await query<InstallRow>(
    `UPDATE model_installs
        SET status = $2,
            detail = $3,
            bytes_received = COALESCE($4, bytes_received),
            started_at = COALESCE(started_at, CASE WHEN $2 = 'downloading' THEN now() END)
      WHERE id = $1
      RETURNING *`,
    [row.id, status, detail, bytesReceived],
  );
  return toModelInstall(rows[0] ?? row);
}

async function finish(
  id: string,
  status: ModelInstallStatus,
  detail: string,
  bytesReceived: number | null,
): Promise<ModelInstall> {
  const row = await queryOne<InstallRow>(
    `UPDATE model_installs
        SET status = $2, detail = $3, bytes_received = COALESCE($4, bytes_received),
            finished_at = now(), error = NULL
      WHERE id = $1
      RETURNING *`,
    [id, status, detail, bytesReceived],
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

/**
 * A refusal the *caller* caused: already installed, or already downloading.
 *
 * Its own class rather than a 409 built at the route, because two routes now
 * start installs — the operator picking an entry out of the catalogue, and the
 * readiness screen closing a workflow's gaps in one click — and "this one is
 * already on its way" is a normal, expected outcome for the second. A batch
 * install must be able to skip it and carry on.
 */
export class InstallConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallConflict';
  }
}

/**
 * Queue one catalogue entry for download on one backend.
 *
 * The whole sequence, in the order that keeps the records true: record the
 * install first, *then* tell the backend to start — a failure to record would
 * otherwise leave a multi-gigabyte download running that nothing tracks — and
 * mark the row failed if the transport refuses.
 *
 * This is the only path that puts a file on a backend. Both install routes go
 * through it; there is deliberately no second downloader.
 */
export async function startInstall(params: {
  backendId: Uuid;
  backendName: string;
  requestedBy: Uuid;
  entry: ModelCatalogEntry;
  transport: ModelTransport;
}): Promise<ModelInstall> {
  const { entry } = params;
  if (entry.installed) {
    throw new InstallConflict(`${entry.filename} is already installed`);
  }

  let row: InstallRow;
  try {
    row = await createInstall({
      backendId: params.backendId,
      requestedBy: params.requestedBy,
      entry,
    });
  } catch (err) {
    // The partial unique index on (backend_id, filename) for live rows.
    if (isUniqueViolation(err)) {
      throw new InstallConflict(
        `${entry.filename} is already being installed on ${params.backendName}`,
      );
    }
    throw err;
  }

  // The exact size, asked once, before anything is downloading. It is a HEAD
  // against the model host, so it costs a round trip and can fail in every way
  // a network call can — and none of those failures may stop an install. A null
  // here simply means the UI will show bytes-so-far without a percentage, which
  // is the honest fallback and exactly what happened before this existed.
  void resolveTotalBytes(row.id, params.transport, requestFromRow(row));

  try {
    await params.transport.install(requestFromRow(row));
  } catch (err) {
    await query(
      `UPDATE model_installs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [row.id, err instanceof Error ? err.message : String(err)],
    );
    throw err;
  }

  return toModelInstall(row);
}

/**
 * Fill in `bytes_total` in the background.
 *
 * Deliberately not awaited by `startInstall`. The operator clicked a button and
 * is owed a response; a HEAD to HuggingFace is not part of that transaction,
 * and blocking on one would make starting a download feel slower than it is for
 * a number that only decorates the result. It lands within a second or two,
 * long before the first poll has anything to show a percentage of.
 *
 * The write is conditional on the row still being live, so a HEAD that comes
 * back after a failed or cancelled install cannot resurrect a number onto it.
 */
async function resolveTotalBytes(
  id: string,
  transport: ModelTransport,
  request: InstallRequest,
): Promise<void> {
  if (!transport.totalBytes) return;
  try {
    const total = await transport.totalBytes(request);
    if (total === null) return;
    await query(
      `UPDATE model_installs SET bytes_total = $2
        WHERE id = $1 AND status IN ('queued', 'downloading')`,
      [id, total],
    );
  } catch {
    // No total, no percentage. Never a failed install.
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
