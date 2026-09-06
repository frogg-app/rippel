/**
 * The Storage tab's half of the API surface: what rippel has left on a
 * ComfyUI machine's disk, and clearing it. See API_CONTRACT.md "Backend
 * storage". Admin only on the server; the page hides the tab for everyone else.
 *
 *   GET    /api/backends/:id/storage
 *     -> 200 BackendStorage. `helper` says whether the comfyui-rippel-storage
 *        node answered; anything but 'ok' comes with two empty groups and the
 *        page shows the install steps instead of an empty list.
 *   DELETE /api/backends/:id/storage   body { type, paths }
 *     -> 200 { deleted, missing }
 *     -> 502 helper_<state> when the helper went away between list and delete.
 *
 * Deleting removes the file from the ComfyUI disk only; the user's library
 * copy is untouched.
 */
import type { BackendStorage, StorageDeletion, StorageFolder, Uuid } from '@comfy/shared';
import { ApiRequestError } from './api';

const BASE = '/api';

interface RequestOptions {
  method?: 'GET' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/** The same private `request` the other api-* files carry: cookies, JSON both
 *  ways, `ApiRequestError` on failure. */
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
    throw new ApiRequestError(0, 'unreachable', 'Cannot reach the rippel server.');
  }
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

export interface StorageApi {
  list(backendId: Uuid, signal?: AbortSignal): Promise<BackendStorage>;
  remove(backendId: Uuid, folder: StorageFolder, paths: string[]): Promise<StorageDeletion>;
}

export const storageApi: StorageApi = {
  list: (backendId, signal) => request<BackendStorage>(`/backends/${backendId}/storage`, { signal }),
  remove: (backendId, folder, paths) =>
    request<StorageDeletion>(`/backends/${backendId}/storage`, {
      method: 'DELETE',
      body: { type: folder, paths },
    }),
};

/** "1.2 GB", "348 MB", "12 kB" — for totals and rows alike. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(bytes >= 10_000_000_000 ? 0 : 1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} B`;
}

/** "just now", "3 h ago", "12 d ago". */
export function ageLabel(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} d ago`;
  return `${Math.round(days / 30)} mo ago`;
}
