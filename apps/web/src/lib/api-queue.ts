/**
 * The queue: `GET /api/queue`, and the small store that keeps one copy of it
 * for every screen that shows it.
 *
 * There is one GPU and several people, so the queue is a real object the
 * product has to show rather than an implementation detail (API_CONTRACT.md,
 * "Queue"). Two places need it — the chip in the top bar, and the Create
 * screen's stage, which has to say *where in line* your job is — and both would
 * otherwise poll separately. So the fetching lives here, in a module store,
 * and `useQueue()` is a subscription to it: one request per interval however
 * many components are mounted.
 *
 * Two properties are deliberate and are what the tests pin.
 *
 *  1. **A missing endpoint is not an error.** The queue API is being built in
 *     parallel and may land after this screen. A 404 means "this feature is not
 *     live", so the store reports `live: false` and every consumer falls back to
 *     what it showed before. Nothing throws, nothing turns red, and the moment
 *     the route exists the UI lights up with no other change.
 *  2. **Another user's params are withheld, not empty.** A non-admin sees a
 *     foreign entry's position and owner and nothing else — `job.params` comes
 *     back `null` on purpose. The shared type says so, so anything that wants
 *     to render a prompt has to check first, and "undefined" can never reach
 *     the screen.
 */
import { useSyncExternalStore } from 'react';
import type { QueueEntry, QueueView } from '@comfy/shared';
import { ApiRequestError } from './api';

const BASE = '/api';

/**
 * `QueueEntry`, `QueueJob` and `QueueView` now live in `@comfy/shared`, which
 * is where they belong — the API and this screen have to agree about them, and
 * a local copy is a copy that rots. Re-exported here so the components that
 * render the queue import one module rather than two.
 *
 * The shape that matters: `QueueJob.params` is `GenerationParams | null`, and
 * the `null` is deliberate. A non-admin sees a foreign entry's position and
 * owner name with its params withheld, and the type says so, so anything that
 * wants to render a prompt has to ask first.
 */
export type { QueueEntry, QueueJob, QueueView } from '@comfy/shared';

export interface QueueSnapshot extends QueueView {
  /**
   * Whether the endpoint answered. `false` means we have no queue information
   * at all — either the route does not exist yet or the server is unreachable —
   * and a consumer must fall back rather than render an empty queue as fact.
   */
  live: boolean;
  /** True until the first answer of any kind. */
  loading: boolean;
}

export const EMPTY_QUEUE: QueueSnapshot = {
  entries: [],
  running: null,
  live: false,
  loading: true,
};

/** Is this entry the signed-in user's own? Params are only ever present on those. */
export function isOwnEntry(entry: QueueEntry, userId: string | null | undefined): boolean {
  return Boolean(userId) && entry.ownerId === userId;
}

/**
 * What to call the person an entry belongs to.
 *
 * A foreign entry always gets *a* name, because "someone" beats a blank and
 * beats an id. It never gets a prompt.
 */
export function ownerLabel(entry: QueueEntry, userId: string | null | undefined): string {
  if (isOwnEntry(entry, userId)) return 'You';
  return entry.ownerName?.trim() || 'Another user';
}

/**
 * The prompt to show for an entry, or null when we are not allowed to know it.
 *
 * Explicitly a function rather than an inline `entry.job.params?.prompt`, so
 * there is one place that decides — and one place to test — that a withheld
 * prompt renders as nothing rather than as the string "undefined".
 */
export function entryPrompt(entry: QueueEntry): string | null {
  const prompt = entry.job.params?.prompt;
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------- fetching

export const queueApi = {
  /**
   * Never rejects. A queue we cannot read is a queue we do not show, which is
   * a strictly better outcome than an exception crossing a render.
   */
  async get(signal?: AbortSignal): Promise<QueueSnapshot> {
    try {
      const response = await fetch(`${BASE}/queue`, { credentials: 'include', signal });
      if (response.status === 404 || response.status === 501) {
        // Not built yet. Not a fault.
        return { entries: [], running: null, live: false, loading: false };
      }
      if (!response.ok) {
        throw new ApiRequestError(response.status, 'queue_failed', 'Could not read the queue.');
      }
      const payload = (await response.json()) as {
        entries?: QueueEntry[] | null;
        running?: QueueEntry | null;
      } | null;
      return {
        // A server that answers with a shape we did not expect is handled the
        // same way as one that does not answer: show nothing, claim nothing.
        entries: Array.isArray(payload?.entries) ? payload.entries : [],
        running: payload?.running ?? null,
        live: true,
        loading: false,
      };
    } catch {
      return { entries: [], running: null, live: false, loading: false };
    }
  },
};

// ---------------------------------------------------------------- store

/**
 * Polling, not the socket.
 *
 * `job.status` frames would keep this live without polling, and the contract
 * says so — but subscribing here would open a second `WS /api/events` per tab
 * purely for a count, and would double-drive the one event seam the Create
 * screen's tests hang off. A poll of a few seconds is a queue: nobody perceives
 * the difference, and the failure mode is "slightly stale" rather than
 * "silently wrong after a reconnect".
 */
const POLL_BUSY_MS = 4_000;
const POLL_IDLE_MS = 12_000;
/** A route that does not exist is retried rarely, so it lights up when it lands. */
const POLL_MISSING_MS = 60_000;

let snapshot: QueueSnapshot = EMPTY_QUEUE;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;

function publish(next: QueueSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function intervalFor(state: QueueSnapshot): number {
  if (!state.live) return POLL_MISSING_MS;
  return state.entries.length > 0 || state.running ? POLL_BUSY_MS : POLL_IDLE_MS;
}

async function poll() {
  if (inFlight) return;
  inFlight = true;
  const next = await queueApi.get();
  inFlight = false;
  if (listeners.size === 0) return; // everyone unmounted while we waited
  publish(next);
  timer = setTimeout(() => void poll(), intervalFor(next));
}

/** Ask now — after submitting a job, say, when waiting 4s to see it is silly. */
export function refreshQueue(): void {
  if (listeners.size === 0) return;
  clearTimeout(timer);
  void poll();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) void poll();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): QueueSnapshot {
  return snapshot;
}

/** The queue, kept current for as long as something is rendering it. */
export function useQueue(): QueueSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------- placing

export interface QueuePlace {
  /** 1-based, for reading: "3rd in line". */
  ordinal: number;
  /** How many jobs are in front. 0 means next. */
  ahead: number;
}

/**
 * Where a job of ours sits in the global line, or null if the queue does not
 * know about it (it is running, it is finished, or the endpoint is missing).
 *
 * Derived from the *order of the array* rather than from `position`, because
 * the contract does not pin whether `position` counts from 0 or 1 and a line
 * that says "0th" or that skips a place is worse than one that says nothing.
 * The array order is unambiguous and is the same information.
 */
export function placeInQueue(state: QueueSnapshot, jobId: string | null): QueuePlace | null {
  if (!state.live || !jobId) return null;
  const index = state.entries.findIndex((entry) => entry.job.id === jobId);
  if (index < 0) return null;
  return { ordinal: index + 1, ahead: index };
}

/** "3rd", "1st" — the queue is short and read at a glance, so words, not "#3". */
export function ordinal(value: number): string {
  const rest = value % 100;
  if (rest >= 11 && rest <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/** Test seam: forget everything between renders. */
export function resetQueueStore(): void {
  clearTimeout(timer);
  timer = undefined;
  inFlight = false;
  snapshot = EMPTY_QUEUE;
}
