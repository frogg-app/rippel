/**
 * The Library screen's half of the API surface.
 *
 * This lives beside `api.ts` rather than inside it on purpose: the library
 * endpoints are being written in parallel with this screen, so keeping them in
 * their own module means the two workstreams never touch the same file. It
 * follows the same rule as `api.ts` — this is the only place in the Library
 * feature that knows a URL, a method or a status code.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THIS SCREEN IS BUILT AGAINST
 * ---------------------------------------------------------------------------
 *
 * Paging is *cursor* based, never offset. The library is a feed with new rows
 * arriving at the top: a finished job inserts assets ahead of everything the
 * user has already scrolled past, and with `?offset=` that shifts every later
 * page by one and the grid both repeats and skips rows. The cursor is an opaque
 * string standing for "the row after this exact one", so an insertion at the
 * head cannot move it.
 *
 *   GET /api/library/assets
 *     query: cursor?      opaque, from a previous response's `nextCursor`
 *            limit?       1..100, default 40
 *            kind?        'image' | 'video'      (omitted = both)
 *            starred?     'true'                 (omitted = all)
 *            collectionId? uuid
 *            q?           free text, matched against the originating job's
 *                         prompt and negative prompt
 *     -> 200 { assets: LibraryAsset[]; nextCursor: string | null }
 *        (this module renames them to `items` internally — see `list` below)
 *        Ordered created_at DESC, id DESC. `nextCursor: null` means this was
 *        the last page. Soft-deleted assets are never included.
 *
 *   GET /api/library/assets/:id
 *     -> 200 { asset: LibraryAsset; job: LibraryJob | null }
 *        `job` is null when the originating job has been purged; the drawer
 *        then shows the asset without its parameters rather than failing.
 *     -> 404 for someone else's asset, exactly as for one that never existed.
 *
 *   PATCH /api/library/assets/:id   body { starred: boolean }
 *     -> 200 { asset: LibraryAsset }
 *
 *   DELETE /api/library/assets/:id
 *     -> 204. A *soft* delete (sets assets.deleted_at); the bytes stay until a
 *        retention pass, which is what makes undo possible.
 *
 *   POST /api/library/assets/:id/restore
 *     -> 200 { asset: LibraryAsset }   the undo affordance
 *
 *   GET  /api/library/collections            -> 200 { collections: Collection[] }
 *   POST /api/library/collections  { name }  -> 201 { collection: Collection }
 *   PUT    /api/library/collections/:id/assets/:assetId -> 204
 *   DELETE /api/library/collections/:id/assets/:assetId -> 204
 *
 * Asset *bytes* are not part of this contract — they already exist and are
 * already authenticated. `Asset.url` and `Asset.thumbUrl` point at
 * `/api/assets/:id` and `/api/assets/:id/thumb`, which serve the real image
 * with the session cookie, so thumbnails work the moment there are any assets.
 */
import type { Asset, GenerationParams, JobKind, JobStatus, Uuid } from '@comfy/shared';
import { ApiRequestError } from './api';
import { mockLibrary } from '../library/mock';

const BASE = '/api';

// ---------------------------------------------------------------- types

/**
 * An asset as the library lists it: the shared `Asset`, plus the handful of
 * fields the *grid* needs that live on the originating job. Denormalised into
 * the row so painting a page of thumbnails is one request rather than one
 * request per tile; everything else the drawer needs comes from the detail
 * call.
 */
export interface LibraryAsset extends Asset {
  /** The prompt this came from. Null when the job has been purged. */
  prompt: string | null;
  /** Display name of the checkpoint, for the grid's model filter chip. */
  modelName: string | null;
  /** Which of the user's collections hold this asset. */
  collectionIds: Uuid[];
}

/** The originating job, reduced to what the detail drawer shows. */
export interface LibraryJob {
  id: Uuid;
  kind: JobKind;
  status: JobStatus;
  /** Everything the Create screen sent. The drawer reads its metadata here. */
  params: GenerationParams;
  /** Resolved display name for `params.modelId`, since the UI cannot resolve it. */
  modelName: string | null;
  /** Resolved LoRA names, in the order of `params.loras`. */
  loraNames: string[];
  /**
   * The seed actually used. `params.advanced.seed` is null for a random seed,
   * and the number the user wants to copy is the one the compiler rolled.
   */
  seed: number | null;
  /** Which backend rendered it, for the "Rendered on" row. */
  backendName: string | null;
  /** Wall-clock render time in milliseconds, null while unfinished. */
  durationMs: number | null;
  createdAt: string;
}

export interface Collection {
  id: Uuid;
  name: string;
  /** Assets currently in it, for the rail's count. */
  assetCount: number;
  createdAt: string;
}

export type LibraryKind = 'image' | 'video';

/** The filter state the toolbar owns, in the shape the query takes. */
export interface LibraryFilters {
  kind?: LibraryKind;
  starred?: boolean;
  collectionId?: Uuid | null;
  q?: string;
}

export interface LibraryPage {
  items: LibraryAsset[];
  /** Null on the last page. Feed it back as `cursor` for the next one. */
  nextCursor: string | null;
}

export interface LibraryPageRequest extends LibraryFilters {
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------- transport

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Deliberately a sibling of `api.ts`'s `request` rather than an import of it:
 * that function is private to its module and this feature is not allowed to
 * edit it while another workstream has it open. The behaviour is identical —
 * cookie credentials, JSON in and out, `ApiRequestError` on the way back — and
 * the two collapse into one the moment both branches have landed.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiRequestError(0, 'unreachable', 'Cannot reach the studio server.');
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload ?? {}) as { error?: string; message?: string };
    throw new ApiRequestError(
      response.status,
      error.error ?? 'error',
      error.message ?? 'Something went wrong.',
    );
  }

  return payload as T;
}

function toQuery(request_: LibraryPageRequest): string {
  const params = new URLSearchParams();
  if (request_.cursor) params.set('cursor', request_.cursor);
  if (request_.limit) params.set('limit', String(request_.limit));
  if (request_.kind) params.set('kind', request_.kind);
  if (request_.starred) params.set('starred', 'true');
  if (request_.collectionId) params.set('collectionId', request_.collectionId);
  const q = request_.q?.trim();
  if (q) params.set('q', q);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

// ---------------------------------------------------------------- the client

export interface LibraryApi {
  assets: {
    list(request: LibraryPageRequest): Promise<LibraryPage>;
    get(id: Uuid, signal?: AbortSignal): Promise<{ asset: LibraryAsset; job: LibraryJob | null }>;
    setStarred(id: Uuid, starred: boolean): Promise<{ asset: LibraryAsset }>;
    remove(id: Uuid): Promise<void>;
    restore(id: Uuid): Promise<{ asset: LibraryAsset }>;
  };
  collections: {
    list(signal?: AbortSignal): Promise<{ collections: Collection[] }>;
    create(name: string): Promise<{ collection: Collection }>;
    add(collectionId: Uuid, assetId: Uuid): Promise<void>;
    remove(collectionId: Uuid, assetId: Uuid): Promise<void>;
  };
}

const liveLibrary: LibraryApi = {
  assets: {
    /**
     * The server calls the page's rows `assets`; this module calls them
     * `items` throughout. Translating here, at the one place the wire format
     * is parsed, keeps that difference from leaking into every component —
     * and mapping the wrong one is what turned this screen black the first
     * time it ran against the real API, because `undefined.map` is not a
     * recoverable render.
     */
    list: async (req) => {
      const body = await request<{ assets: LibraryAsset[]; nextCursor: string | null }>(
        `/library/assets${toQuery(req)}`,
        { signal: req.signal },
      );
      return { items: body.assets ?? [], nextCursor: body.nextCursor ?? null };
    },
    get: (id, signal) =>
      request<{ asset: LibraryAsset; job: LibraryJob | null }>(`/library/assets/${id}`, { signal }),
    setStarred: (id, starred) =>
      request<{ asset: LibraryAsset }>(`/library/assets/${id}`, {
        method: 'PATCH',
        body: { starred },
      }),
    remove: (id) => request<void>(`/library/assets/${id}`, { method: 'DELETE' }),
    restore: (id) =>
      request<{ asset: LibraryAsset }>(`/library/assets/${id}/restore`, { method: 'POST' }),
  },
  collections: {
    list: (signal) => request<{ collections: Collection[] }>('/library/collections', { signal }),
    create: (name) =>
      request<{ collection: Collection }>('/library/collections', {
        method: 'POST',
        body: { name },
      }),
    add: (collectionId, assetId) =>
      request<void>(`/library/collections/${collectionId}/assets/${assetId}`, { method: 'PUT' }),
    remove: (collectionId, assetId) =>
      request<void>(`/library/collections/${collectionId}/assets/${assetId}`, { method: 'DELETE' }),
  },
};

/**
 * Whether to talk to the in-memory fixture instead of the server.
 *
 * The routes now exist, so this defaults to OFF and the screen talks to the
 * server. It is kept as an opt-in (`VITE_LIBRARY_MOCK=1`) because the fixture
 * is the only way to see a full grid, the empty state and a paging boundary on
 * a fresh install with three images in it.
 *
 * Off in a production build regardless of the flag — a shipped bundle must
 * never quietly serve fixtures.
 */
export const usingMockLibrary: boolean =
  import.meta.env.DEV && import.meta.env.VITE_LIBRARY_MOCK === '1';

export const libraryApi: LibraryApi = usingMockLibrary ? mockLibrary : liveLibrary;

// ---------------------------------------------------------------- download

/**
 * Save an asset to disk.
 *
 * `<a download href="/api/assets/:id">` looks like it would do this, but the
 * route answers `content-disposition: inline` and — more to the point — the
 * bytes are behind a session cookie and a cross-document navigation would
 * simply display them. Fetching the blob keeps the credentialed request and
 * lets us name the file after the asset.
 */
export async function downloadAsset(asset: Asset, filename?: string): Promise<void> {
  const response = await fetch(asset.url, { credentials: 'include' });
  if (!response.ok) {
    throw new ApiRequestError(response.status, 'download_failed', 'Could not download that file.');
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename ?? defaultFilename(asset, blob.type);
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Revoking synchronously can race the click on some browsers; a turn of
    // the event loop is enough and leaks nothing.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

function defaultFilename(asset: Asset, mimeType: string): string {
  const extension = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  return `studio-${asset.id.slice(0, 8)}.${extension}`;
}
