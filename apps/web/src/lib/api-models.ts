/**
 * The Models screen's half of the API surface.
 *
 * Sits beside `api.ts` and `api-library.ts` for the same reason those two are
 * separate: the screens are being built in parallel and must not share a file.
 * It is the only place in the Models feature that knows a URL, a method or a
 * status code.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THIS SCREEN IS BUILT AGAINST
 * ---------------------------------------------------------------------------
 * Verified by hand against the live API and a real ComfyUI-Manager backend on
 * 2026-09-06; the notes below are what the responses actually did, not what
 * was assumed.
 *
 *   GET /api/backends
 *     -> 200 { backends: Backend[] }        requireAuth
 *
 *   GET /api/models?runnability=1
 *     -> 200 { models: Model[]; families: string[]; runnability?: Record<Uuid, ModelRunnability> }
 *     **requireAuth, not requireAdmin.** Every signed-in user may see what is
 *     installed; only installing is an operator action. `Model.backendIds`
 *     names the machines that actually hold the file, which is what lets the
 *     installed view answer "which machines have this" without a call per
 *     backend.
 *     `families` are *folded* spellings — "sdxl", "hunyuan-video" — while a
 *     catalogue entry's `base` is the catalogue's own — "SDXL", "Hunyuan
 *     Video". Two vocabularies over the same idea; they must never be offered
 *     as one filter list. See `foldFamily` in ../models/catalogue.ts.
 *     A filename can carry a subfolder, including a Windows one:
 *     "SDXL\\sd_xl_base_1.0.safetensors". Compare on the basename.
 *     `runnability` is **opt-in** and keyed by model id, not folded into
 *     `Model`: answering it costs a `/object_info` read per online backend, and
 *     the Create screen calls this route on every load. Ask for it here, where
 *     it is the whole point, and nowhere else.
 *
 *   GET /api/backends/:id/catalogue                     admin only
 *     -> 200 { entries: ModelCatalogEntry[]; pending: number }
 *     -> 501 { error: 'not_implemented', message }  the backend has no install
 *        mechanism at all. The message names the fix ("Install ComfyUI-Manager
 *        into the backend's custom_nodes and restart ComfyUI") and is meant to
 *        be rendered verbatim rather than flattened into "something failed".
 *     -> 502 the transport is there but erroring.
 *     372 entries on the real box, across 6 types and 42 base families, of
 *     which 2 were flagged `installed`. `size` is a human string ("6.94GB")
 *     that is sometimes null, so this still cannot sort by size.
 *     Each entry now also carries:
 *       `info`         preview image, licence, downloads — resolved server-side
 *                      from the entry's model page and cached there. Null until
 *                      it has been. `info.previewUrl` is a path on **this** API
 *                      (`/api/model-previews/<id>`); the browser never talks to
 *                      huggingface.co, which is deliberate — see the API's
 *                      models/metadata.ts.
 *       `runnability`  whether it would actually work on this backend. Measured
 *                      on the live catalogue: 5 ready, 26 generic, 19 needing a
 *                      companion model, 40 landing in a folder no workflow can
 *                      read, 55 with no workflow at all, 227 support files.
 *     `pending` is how many model pages are still being resolved in the
 *     background. Non-zero means asking again shortly returns more `info`;
 *     zero means this is as good as it gets and polling is pointless.
 *
 *   POST /api/backends/:id/models  { ref }
 *     -> 202 { install: ModelInstall }
 *     -> 400 the ref is not in this backend's catalogue. Installs are
 *        whitelisted, so the flow is "pick from this backend's catalogue" and
 *        there is deliberately no paste-a-URL affordance anywhere.
 *     -> 409 already installed, or already being installed here.
 *
 *   GET /api/backends/:id/models/installs            -> { installs }  100, newest first
 *   GET /api/backends/:id/models/installs/:installId -> { install }   refreshes on read
 *   GET /api/model-installs                          -> { installs }  in flight, all backends
 *
 * Progress is per *task*, never per byte: `ModelInstall.detail` carries what
 * the transport said, and no percentage exists anywhere in the contract.
 * Nothing in this feature may invent one.
 */
import type {
  Backend,
  Model,
  ModelCatalogEntry,
  ModelInstall,
  ModelRunnability,
  Uuid,
} from '@comfy/shared';
import { ApiRequestError } from './api';

const BASE = '/api';

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * A sibling of `api.ts`'s private `request`, identical in behaviour — cookie
 * credentials, JSON both ways, `ApiRequestError` on failure. The two collapse
 * into one once the parallel branches have landed.
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

export interface InstalledModels {
  models: Model[];
  /** Folded family names, e.g. "sdxl". Only ever filters the installed list. */
  families: string[];
  /**
   * Verdict per model id, when it was asked for. Empty rather than absent, so
   * a caller never has to distinguish "not asked" from "nothing to say" —
   * both mean the same thing to the list.
   */
  runnability: Record<Uuid, ModelRunnability>;
}

export interface CatalogueResult {
  entries: ModelCatalogEntry[];
  /** Model pages still being resolved server-side. 0 means nothing to wait for. */
  pending: number;
}

export interface ModelsApi {
  backends(signal?: AbortSignal): Promise<Backend[]>;
  installed(signal?: AbortSignal): Promise<InstalledModels>;
  catalogue(backendId: Uuid, signal?: AbortSignal): Promise<CatalogueResult>;
  /** 202 on success; the install comes back `queued` and is then polled. */
  install(backendId: Uuid, ref: string): Promise<ModelInstall>;
  installHistory(backendId: Uuid, signal?: AbortSignal): Promise<ModelInstall[]>;
  /** Refreshes from the backend on read — this is the poll target. */
  installStatus(backendId: Uuid, installId: Uuid, signal?: AbortSignal): Promise<ModelInstall>;
  /** Everything in flight, across every backend. The adoption call on mount. */
  activeInstalls(signal?: AbortSignal): Promise<ModelInstall[]>;
}

export const modelsApi: ModelsApi = {
  backends: async (signal) =>
    (await request<{ backends: Backend[] }>('/backends', { signal })).backends ?? [],

  installed: async (signal) => {
    const body = await request<{
      models: Model[];
      families: string[];
      runnability?: Record<Uuid, ModelRunnability>;
    }>('/models?runnability=1', { signal });
    return {
      models: body.models ?? [],
      families: body.families ?? [],
      runnability: body.runnability ?? {},
    };
  },

  catalogue: async (backendId, signal) => {
    const body = await request<{ entries: ModelCatalogEntry[]; pending?: number }>(
      `/backends/${backendId}/catalogue`,
      { signal },
    );
    return { entries: body.entries ?? [], pending: body.pending ?? 0 };
  },

  install: async (backendId, ref) =>
    (
      await request<{ install: ModelInstall }>(`/backends/${backendId}/models`, {
        method: 'POST',
        body: { ref },
      })
    ).install,

  installHistory: async (backendId, signal) =>
    (
      await request<{ installs: ModelInstall[] }>(`/backends/${backendId}/models/installs`, {
        signal,
      })
    ).installs ?? [],

  installStatus: async (backendId, installId, signal) =>
    (
      await request<{ install: ModelInstall }>(
        `/backends/${backendId}/models/installs/${installId}`,
        { signal },
      )
    ).install,

  activeInstalls: async (signal) =>
    (await request<{ installs: ModelInstall[] }>('/model-installs', { signal })).installs ?? [],
};
