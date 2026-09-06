/**
 * The one module in the app that calls `fetch`.
 *
 * Everything else asks for a named operation — `api.auth.login(...)`,
 * `api.backends.list()` — and never sees a URL, a method or a status code. That
 * keeps three decisions in one place: where the API lives, that the session is
 * a cookie (so every request needs `credentials: 'include'`), and how a failure
 * turns into something a component can render.
 */
import type { ApiError, Backend, User } from '@comfy/shared';

/**
 * Always same-origin. In dev the Vite proxy forwards `/api` to Fastify on
 * :4000, in production a reverse proxy does the same, so the session cookie is
 * host-only in both and there is never a cross-origin request to configure.
 */
const BASE = '/api';

/** A request that reached the server and came back a failure. */
export class ApiRequestError extends Error {
  readonly status: number;
  /** The API's machine-readable code, e.g. `invalid_credentials`. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }

  /** True when the caller should show the sign-in screen rather than an error. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

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
      // The session is an httpOnly cookie; without this the browser sends
      // nothing and every authenticated call 401s.
      credentials: 'include',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    // A transport failure is not the API refusing us — it is the API being
    // unreachable, which for a self-hosted stack is the common case and
    // deserves its own wording rather than "something went wrong".
    if (signal?.aborted) throw cause;
    throw new ApiRequestError(0, 'unreachable', 'Cannot reach the rippel server.');
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(
      response.status,
      error.error ?? 'error',
      error.message ?? 'Something went wrong.',
    );
  }

  return payload as T;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface Registration extends Credentials {
  displayName?: string;
}

export const api = {
  auth: {
    /**
     * Whether to offer a sign-up link at all. The API also says yes on an empty
     * install regardless of ALLOW_REGISTRATION, so the first admin can be made.
     */
    config: () => request<{ allowRegistration: boolean }>('/auth/config'),
    /** 401s when signed out — callers treat that as "anonymous", not an error. */
    me: () => request<{ user: User }>('/auth/me'),
    login: (credentials: Credentials) =>
      request<{ user: User }>('/auth/login', { method: 'POST', body: credentials }),
    register: (registration: Registration) =>
      request<{ user: User }>('/auth/register', { method: 'POST', body: registration }),
    logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
  },

  backends: {
    /**
     * Feeds the status pill. `baseUrl` comes back empty for non-admins — it is
     * an internal LAN address — so never render it unconditionally.
     */
    list: (signal?: AbortSignal) => request<{ backends: Backend[] }>('/backends', { signal }),
  },
};
