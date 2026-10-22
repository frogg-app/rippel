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

/** What a person reads when the server could not be reached at all. */
export const UNREACHABLE = 'Can’t reach rippel. Check your connection.';
/** A gateway in front of the API (or the API's own upstream) gave up. */
export const NO_ANSWER = 'rippel’s server didn’t answer. Try again in a moment.';
const GENERIC = 'Something went wrong. Try again.';

/**
 * Status phrases a framework or proxy puts in `message` when it has nothing
 * to say ("Unsupported Media Type", "Bad Gateway"). They name the protocol,
 * not the problem, so they are never shown; they go into `detail` instead.
 */
const STATUS_PHRASES = [
  'bad request', 'unauthorized', 'forbidden', 'not found', 'method not allowed', 'not acceptable',
  'request timeout', 'conflict', 'gone', 'payload too large', 'unsupported media type',
  'unprocessable entity', 'too many requests', 'internal server error', 'not implemented',
  'bad gateway', 'service unavailable', 'gateway timeout', 'error', 'something went wrong',
];

/** True when `message` says something specific a person can act on. */
export function isSpecificMessage(message: string | null | undefined): message is string {
  if (typeof message !== 'string') return false;
  const text = message.trim().replace(/[.!]$/, '').toLowerCase();
  if (!text || text === 'undefined' || text === 'null' || text === '[object object]') return false;
  return !STATUS_PHRASES.some((phrase) => text === phrase || text.startsWith(`${phrase}:`));
}

/** A request that reached the server and came back a failure, or did not reach it. */
export class ApiRequestError extends Error {
  readonly status: number;
  /** The API's machine-readable code, e.g. `invalid_credentials`. */
  readonly code: string;
  /** What actually came back, for a tooltip or a bug report; never the headline. */
  readonly detail: string;
  /** True when `message` is a stand-in because the server said nothing useful. */
  readonly generic: boolean;

  /**
   * `message` is the server's; the constructor decides whether a person sees
   * it. A specific one is kept, so "That file is too large" still reaches the
   * person who dropped it. A bare status phrase or nothing at all becomes a
   * plain line, and every copy of `request()` in lib/ gets that for free.
   */
  constructor(status: number, code: string, message: string) {
    const specific = status !== 0 && isSpecificMessage(message);
    const shown =
      status === 0 ? UNREACHABLE : specific ? message : status >= 502 && status <= 504 ? NO_ANSWER : GENERIC;
    super(shown);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.generic = !specific && status !== 0;
    this.detail = status === 0 ? `No response (${code})` : `HTTP ${status} ${code}${message && message !== code ? `: ${message}` : ''}`;
  }

  /** True when the caller should show the sign-in screen rather than an error. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/**
 * The one line to show for a failed action, tied to what was being done:
 * "Couldn't test the agent. Try again." when the server gave no reason, the
 * server's own words when it did, and the network lines as they are.
 */
export function errorLine(cause: unknown, action: string): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 0 || (cause.status >= 502 && cause.status <= 504 && cause.generic)) return cause.message;
    return cause.generic ? `Couldn’t ${action}. Try again.` : cause.message;
  }
  if (cause instanceof Error && isSpecificMessage(cause.message)) return cause.message;
  return `Couldn’t ${action}. Try again.`;
}

/**
 * The server's words when they are specific, else `fallback` — the caller's
 * own sentence for the action ("Could not load users."). For call sites that
 * already had a fallback and only needed the bare-status cases caught.
 */
export function messageOr(cause: unknown, fallback: string): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 0 || !cause.generic) return cause.message;
    if (cause.status >= 502 && cause.status <= 504) return cause.message;
    return fallback;
  }
  return cause instanceof Error && isSpecificMessage(cause.message) ? cause.message : fallback;
}

/** The raw detail behind `errorLine`, for a `title`. */
export function errorDetail(cause: unknown): string | undefined {
  if (cause instanceof ApiRequestError) return cause.detail;
  return cause instanceof Error ? cause.message : undefined;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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
