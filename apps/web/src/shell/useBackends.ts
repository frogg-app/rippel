import { useEffect, useState } from 'react';
import type { Backend } from '@comfy/shared';
import { api } from '../lib/api';

/** The API's poller refreshes backend state every 15s; polling faster only
 *  re-reads the same row. */
const POLL_MS = 15_000;

export interface BackendsState {
  backends: Backend[];
  /** True only before the first answer, so the pill can hold its shape. */
  loading: boolean;
  /** Set when the API itself is unreachable — a different thing from a
   *  backend being offline, and worth saying differently. */
  unreachable: boolean;
}

/**
 * Feeds the chrome that PLAN.md §6 says is on every screen. It lives in a hook
 * rather than the pill component so a future Library or Models screen can show
 * the same numbers without a second poll loop.
 */
/**
 * Anyone who has just changed the fleet — the Settings modal, after a save —
 * calls this so every mounted `useBackends` re-reads at once rather than
 * waiting out the poll. A tiny subscriber set, not an event bus.
 */
const listeners = new Set<() => void>();

export function refreshBackends(): void {
  for (const listener of listeners) listener();
}

export function useBackends(): BackendsState {
  const [state, setState] = useState<BackendsState>({
    backends: [],
    loading: true,
    unreachable: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const tick = async () => {
      try {
        const { backends } = await api.backends.list(controller.signal);
        if (!stopped) setState({ backends, loading: false, unreachable: false });
      } catch {
        if (!stopped) setState((prev) => ({ ...prev, loading: false, unreachable: true }));
      }
      // Only schedule the next poll once this one has landed, so a slow or
      // hanging API cannot pile up requests.
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };

    // A backgrounded tab does not need to know the GPU's memory; polling
    // resumes — immediately — when the user comes back to it.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !stopped) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    const onRefresh = () => {
      if (stopped) return;
      clearTimeout(timer);
      void tick();
    };
    listeners.add(onRefresh);

    void tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
      listeners.delete(onRefresh);
    };
  }, []);

  return state;
}

/**
 * The pill has room for one backend. Prefer an online one — "is my server up?"
 * is the question it exists to answer, and an enabled-but-offline box is the
 * next most interesting thing.
 */
export function primaryBackend(backends: Backend[]): Backend | null {
  const enabled = backends.filter((backend) => backend.enabled);
  return enabled.find((backend) => backend.status === 'online') ?? enabled[0] ?? backends[0] ?? null;
}

/** Total work in flight across every backend, for the queue chip. */
export function totalQueueDepth(backends: Backend[]): number {
  return backends.reduce((sum, backend) => sum + backend.queueDepth, 0);
}
