/**
 * What rippel has left on a ComfyUI machine, and who it belongs to.
 *
 * ComfyUI's own API cannot answer either question: `/internal/files/*` lists
 * one folder level and there is no delete route at all. The
 * comfyui-rippel-storage helper node (tools/comfyui-rippel-storage) adds a
 * scoped list/delete over the two `comfy-studio/` subfolders rippel writes to;
 * this module is its client, plus the join that turns a bare filename into a
 * person.
 *
 * Attribution is by construction, not by asking the backend:
 *
 *  - An output lands at `output/comfy-studio/<kind>/<jobId>/<file>` (the
 *    compiler's filename_prefix), so the job id is in the path and the job's
 *    owner is the owner. The asset row, when persistence kept one, is matched
 *    on (job_id, source_filename).
 *  - An input lands at `input/comfy-studio/<hash>.<ext>` where `<hash>` is the
 *    first 32 hex characters of sha256(stored bytes) — see
 *    workflows/init-image.ts. Uploads and assets record that hash (migration
 *    010); rows from before it are hashed on demand, a bounded batch per
 *    request, and the answer is cached in the column.
 *
 * Deleting here removes a file from the ComfyUI disk only. The user's library
 * copy lives in rippel's own storage and is never touched by this module.
 */

import type { FastifyInstance } from 'fastify';
import type {
  BackendStorage,
  StorageDeletion,
  StorageFile,
  StorageFolder,
  StorageGroup,
  StorageHelperState,
  StorageOwner,
} from '@comfy/shared';
import { query as defaultQuery, queryOne as defaultQueryOne } from '../db.js';
import { env } from '../env.js';
import type { StorageDriver } from '../storage/driver.js';
import { storage as defaultStorage } from '../storage/index.js';
import { contentHash } from '../workflows/init-image.js';

// ---------------------------------------------------------------- helper client

export interface HelperFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface HelperListing {
  root: string;
  files: HelperFile[];
  totalBytes: number;
}

/** How the helper answered, or why it could not. */
export type HelperProbe = { state: 'ok' } | { state: Exclude<StorageHelperState, 'ok'> };

export interface StorageHelper {
  probe(baseUrl: string): Promise<HelperProbe>;
  list(baseUrl: string, folder: StorageFolder): Promise<HelperListing>;
  remove(baseUrl: string, folder: StorageFolder, paths: string[]): Promise<StorageDeletion>;
  /** Delete one model file from a ComfyUI model folder (checkpoints, loras, ...). */
  removeModel(baseUrl: string, folder: string, filename: string): Promise<{ deleted: boolean; path: string }>;
}

export class HelperError extends Error {
  constructor(
    readonly state: Exclude<StorageHelperState, 'ok'> | 'not-found',
    message: string,
  ) {
    super(message);
    this.name = 'HelperError';
  }
}

const HELPER_TIMEOUT_MS = 10_000;

/**
 * The real client. `fetchImpl` is injectable so the routes can be tested
 * against a scripted helper without a network.
 */
export function makeStorageHelper(opts: {
  token: string;
  fetchImpl?: typeof fetch;
}): StorageHelper {
  const fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));

  async function call(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${baseUrl.replace(/\/+$/, '')}/rippel/storage/${path}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          'X-Rippel-Token': opts.token,
        },
        signal: AbortSignal.timeout(HELPER_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new HelperError('offline', `The backend did not answer: ${(cause as Error).message}`);
    }
    if (res.status === 404) {
      // A 404 with a JSON body is the helper itself answering "no such file";
      // a bare 404 is ComfyUI saying there is no such route.
      const text = await res.text().catch(() => '');
      let notFound: string | null = null;
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        if (parsed?.error === 'not_found') notFound = parsed.message ?? 'Not found.';
      } catch {
        // not JSON: the helper is not installed
      }
      if (notFound) throw new HelperError('not-found', notFound);
      throw new HelperError('missing', 'The comfyui-rippel-storage helper is not installed.');
    }
    if (res.status === 401 || res.status === 503) {
      throw new HelperError('unauthorised', 'The storage token is not set, or does not match.');
    }
    if (!res.ok) {
      throw new HelperError('offline', `The helper answered ${res.status}.`);
    }
    return res;
  }

  return {
    async probe(baseUrl) {
      try {
        await call(baseUrl, 'ping');
        return { state: 'ok' };
      } catch (cause) {
        if (cause instanceof HelperError && cause.state !== 'not-found') return { state: cause.state };
        throw cause;
      }
    },
    async list(baseUrl, folder) {
      const res = await call(baseUrl, `files?type=${folder}`);
      const body = (await res.json()) as Partial<HelperListing>;
      return {
        root: body.root ?? '',
        files: Array.isArray(body.files) ? body.files : [],
        totalBytes: Number(body.totalBytes ?? 0),
      };
    },
    async remove(baseUrl, folder, paths) {
      const res = await call(baseUrl, 'files', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: folder, paths }),
      });
      const body = (await res.json()) as Partial<StorageDeletion>;
      return { deleted: body.deleted ?? [], missing: body.missing ?? [] };
    },
    async removeModel(baseUrl, folder, filename) {
      const res = await call(baseUrl, 'models', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder, filename }),
      });
      const body = (await res.json()) as { deleted?: boolean; path?: string };
      return { deleted: Boolean(body.deleted), path: body.path ?? '' };
    },
  };
}

// ---------------------------------------------------------------- path parsing

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OUTPUT_PATH = new RegExp(`^(image|video)/(${UUID})/([^/]+)$`, 'i');
const INPUT_HASH = /^([0-9a-f]{32})\.[a-z0-9]+$/i;

/** `image/<jobId>/ComfyUI_00003_.png` -> its parts, or null for anything else. */
export function parseOutputPath(path: string): { kind: string; jobId: string; file: string } | null {
  const m = OUTPUT_PATH.exec(path);
  return m ? { kind: m[1]!.toLowerCase(), jobId: m[2]!.toLowerCase(), file: m[3]! } : null;
}

/** `<hash>.png` -> the hash, or null for a name rippel did not write. */
export function parseInputHash(path: string): string | null {
  const m = INPUT_HASH.exec(path);
  return m ? m[1]!.toLowerCase() : null;
}

// ---------------------------------------------------------------- attribution

export interface StorageDb {
  query: typeof defaultQuery;
  queryOne: typeof defaultQueryOne;
}

interface OwnerRow {
  user_id: string;
  email: string;
  display_name: string | null;
}

interface JobOwnerRow extends OwnerRow {
  id: string;
}

interface AssetByJobRow {
  id: string;
  job_id: string;
  source_filename: string | null;
}

interface HashRow extends OwnerRow {
  id: string;
  content_hash: string;
}

interface UnhashedRow {
  id: string;
  storage_key: string;
}

function owner(row: OwnerRow): StorageOwner {
  return { id: row.user_id, email: row.email, displayName: row.display_name };
}

/** How many old rows to hash on one request. Each is a full object read. */
const BACKFILL_BATCH = 200;

export async function attributeOutputs(files: HelperFile[], db: StorageDb): Promise<StorageFile[]> {
  const parsed = files.map((file) => ({ file, out: parseOutputPath(file.path) }));
  const jobIds = [...new Set(parsed.flatMap((p) => (p.out ? [p.out.jobId] : [])))];

  const jobs = new Map<string, JobOwnerRow>();
  const assets = new Map<string, string>(); // `${jobId}/${filename}` -> assetId
  if (jobIds.length > 0) {
    for (const row of await db.query<JobOwnerRow>(
      `SELECT j.id, j.user_id, u.email, u.display_name
         FROM jobs j JOIN users u ON u.id = j.user_id
        WHERE j.id = ANY($1::uuid[])`,
      [jobIds],
    )) {
      jobs.set(row.id, row);
    }
    for (const row of await db.query<AssetByJobRow>(
      `SELECT id, job_id, source_filename FROM assets
        WHERE job_id = ANY($1::uuid[]) AND source_filename IS NOT NULL`,
      [jobIds],
    )) {
      assets.set(`${row.job_id}/${row.source_filename}`, row.id);
    }
  }

  return parsed.map(({ file, out }) => {
    const job = out ? jobs.get(out.jobId) : undefined;
    const entry: StorageFile = { ...file, owner: job ? owner(job) : null };
    if (out && job) {
      entry.jobId = out.jobId;
      const assetId = assets.get(`${out.jobId}/${out.file}`);
      if (assetId) entry.assetId = assetId;
    }
    return entry;
  });
}

/**
 * Hash rows that predate migration 010, a bounded batch at a time, so an old
 * install becomes attributable over a few visits without one request reading
 * every object in storage.
 */
async function backfillHashes(
  table: 'uploads' | 'assets',
  db: StorageDb,
  driver: StorageDriver,
): Promise<void> {
  const rows = await db.query<UnhashedRow>(
    `SELECT id, storage_key FROM ${table}
      WHERE content_hash IS NULL
      ORDER BY created_at DESC
      LIMIT ${BACKFILL_BATCH}`,
  );
  for (const row of rows) {
    let hash: string;
    try {
      hash = contentHash(await driver.get(row.storage_key));
    } catch {
      // A missing object stays NULL and is retried next time; it cannot be on
      // a backend if it is not in storage either.
      continue;
    }
    await db.query(`UPDATE ${table} SET content_hash = $2 WHERE id = $1`, [row.id, hash]);
  }
}

export async function attributeInputs(
  files: HelperFile[],
  db: StorageDb,
  driver: StorageDriver,
): Promise<StorageFile[]> {
  const parsed = files.map((file) => ({ file, hash: parseInputHash(file.path) }));
  const hashes = [...new Set(parsed.flatMap((p) => (p.hash ? [p.hash] : [])))];
  if (hashes.length === 0) return parsed.map(({ file }) => ({ ...file, owner: null }));

  const lookup = async () => {
    const uploads = new Map<string, HashRow>();
    const assets = new Map<string, HashRow>();
    for (const row of await db.query<HashRow>(
      `SELECT p.id, p.content_hash, p.user_id, u.email, u.display_name
         FROM uploads p JOIN users u ON u.id = p.user_id
        WHERE p.content_hash = ANY($1::text[])`,
      [hashes],
    )) {
      if (!uploads.has(row.content_hash)) uploads.set(row.content_hash, row);
    }
    for (const row of await db.query<HashRow>(
      `SELECT a.id, a.content_hash, a.user_id, u.email, u.display_name
         FROM assets a JOIN users u ON u.id = a.user_id
        WHERE a.content_hash = ANY($1::text[])`,
      [hashes],
    )) {
      if (!assets.has(row.content_hash)) assets.set(row.content_hash, row);
    }
    return { uploads, assets };
  };

  let found = await lookup();
  const unmatched = hashes.some((h) => !found.uploads.has(h) && !found.assets.has(h));
  if (unmatched) {
    await backfillHashes('uploads', db, driver);
    await backfillHashes('assets', db, driver);
    found = await lookup();
  }

  return parsed.map(({ file, hash }) => {
    const upload = hash ? found.uploads.get(hash) : undefined;
    const asset = hash ? found.assets.get(hash) : undefined;
    const entry: StorageFile = { ...file, owner: null };
    if (upload) {
      entry.owner = owner(upload);
      entry.uploadId = upload.id;
    } else if (asset) {
      entry.owner = owner(asset);
      entry.assetId = asset.id;
    }
    return entry;
  });
}

// ---------------------------------------------------------------- routes

interface BackendRow {
  id: string;
  name: string;
  base_url: string;
}

export interface StorageRouteDeps {
  db?: StorageDb;
  helper?: StorageHelper;
  driver?: () => StorageDriver;
}

const FOLDERS: readonly StorageFolder[] = ['input', 'output'];

function isFolder(value: unknown): value is StorageFolder {
  return typeof value === 'string' && (FOLDERS as readonly string[]).includes(value);
}

export function makeStorageRoutes(deps: StorageRouteDeps = {}) {
  const db: StorageDb = deps.db ?? { query: defaultQuery, queryOne: defaultQueryOne };
  const helper = deps.helper ?? makeStorageHelper({ token: env.comfyStorageToken });
  const driver = deps.driver ?? defaultStorage;

  return async function storageRoutes(app: FastifyInstance) {
    async function backendOr404(id: string) {
      return db.queryOne<BackendRow>(`SELECT id, name, base_url FROM backends WHERE id = $1`, [
        id,
      ]);
    }

    app.get<{ Params: { id: string } }>(
      '/backends/:id/storage',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const backend = await backendOr404(req.params.id);
        if (!backend) {
          return reply.code(404).send({ error: 'not_found', message: 'No such backend.' });
        }

        const empty = (): StorageGroup => ({ totalBytes: 0, files: [] });
        const probe = await helper.probe(backend.base_url);
        if (probe.state !== 'ok') {
          const body: BackendStorage = { helper: probe.state, input: empty(), output: empty() };
          return body;
        }

        try {
          const [input, output] = await Promise.all([
            helper.list(backend.base_url, 'input'),
            helper.list(backend.base_url, 'output'),
          ]);
          const body: BackendStorage = {
            helper: 'ok',
            input: {
              totalBytes: input.totalBytes,
              files: await attributeInputs(input.files, db, driver()),
            },
            output: {
              totalBytes: output.totalBytes,
              files: await attributeOutputs(output.files, db),
            },
          };
          return body;
        } catch (cause) {
          if (cause instanceof HelperError) {
            // Listing never yields not-found; treat the impossible as offline.
            const state = cause.state === 'not-found' ? 'offline' : cause.state;
            const body: BackendStorage = { helper: state, input: empty(), output: empty() };
            return body;
          }
          throw cause;
        }
      },
    );

    app.delete<{ Params: { id: string }; Body: { type?: unknown; paths?: unknown } }>(
      '/backends/:id/storage',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const backend = await backendOr404(req.params.id);
        if (!backend) {
          return reply.code(404).send({ error: 'not_found', message: 'No such backend.' });
        }
        const type = req.body?.type;
        const paths = req.body?.paths;
        if (
          !isFolder(type) ||
          !Array.isArray(paths) ||
          paths.length === 0 ||
          !paths.every((p) => typeof p === 'string' && p.length > 0)
        ) {
          return reply.code(400).send({
            error: 'invalid_input',
            message: 'Send { type: "input" | "output", paths: string[] } with at least one path.',
          });
        }
        try {
          const result = await helper.remove(backend.base_url, type, paths);
          return result;
        } catch (cause) {
          if (cause instanceof HelperError) {
            return reply.code(502).send({ error: `helper_${cause.state}`, message: cause.message });
          }
          throw cause;
        }
      },
    );
  };
}

export default makeStorageRoutes();
