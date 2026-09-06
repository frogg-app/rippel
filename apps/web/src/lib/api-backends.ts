/**
 * Backend management, for the Settings modal. Admin only on the server; the
 * modal is not offered to anyone else.
 */
import type { Backend, BackendInput, BackendProbe, Uuid } from '@comfy/shared';
import { ApiRequestError } from './api';

const BASE = '/api';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

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
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload ?? {}) as { error?: string; message?: string; field?: string };
    const thrown = new ApiRequestError(
      response.status,
      error.error ?? 'error',
      error.message ?? 'Something went wrong.',
    ) as ApiRequestError & { field?: string };
    // Validation errors name the field, so the form can point at it.
    if (error.field) thrown.field = error.field;
    throw thrown;
  }
  return payload as T;
}

export interface BackendsApi {
  list(signal?: AbortSignal): Promise<Backend[]>;
  create(input: BackendInput): Promise<Backend>;
  update(id: Uuid, patch: Partial<BackendInput>): Promise<Backend>;
  remove(id: Uuid): Promise<void>;
  probe(id: Uuid): Promise<BackendProbe>;
  probeAddress(baseUrl: string): Promise<BackendProbe>;
}

export const backendsApi: BackendsApi = {
  list: async (signal) => (await request<{ backends: Backend[] }>('/backends', { signal })).backends,
  create: async (input) =>
    (await request<{ backend: Backend }>('/backends', { method: 'POST', body: input })).backend,
  update: async (id, patch) =>
    (await request<{ backend: Backend }>(`/backends/${id}`, { method: 'PATCH', body: patch })).backend,
  remove: (id) => request<void>(`/backends/${id}`, { method: 'DELETE' }),
  probe: (id) => request<BackendProbe>(`/backends/${id}/probe`, { method: 'POST' }),
  probeAddress: (baseUrl) =>
    request<BackendProbe>('/backends/probe', { method: 'POST', body: { baseUrl } }),
};
