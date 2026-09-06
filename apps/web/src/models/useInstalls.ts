/**
 * Model installs — starting them, and watching the ones already running.
 *
 * Three properties of the API decide the shape of this hook:
 *
 *  1. **A download outlives the page.** A 7 GB checkpoint takes many minutes;
 *     the operator will navigate away, reload, or come back tomorrow. So on
 *     mount we ask `/api/model-installs` what is already in flight and adopt
 *     it, rather than assuming this page started everything it can see.
 *  2. **The percentage, where one exists, arrives inside the install.** The
 *     transport reports queue state per task, but the API measures the file
 *     growing on the backend and pairs it with the download's exact size, so a
 *     `ModelInstall` carries `bytesReceived` and `bytesTotal` already computed.
 *     This hook therefore still holds no notion of progress of its own and
 *     still cannot invent one — when either field is null there is genuinely no
 *     percentage, and the display falls back to elapsed time.
 *  3. **The single-install route refreshes on read.** Polling
 *     `/backends/:id/models/installs/:installId` is what actually advances an
 *     install, so that is the poll target while anything is live. With nothing
 *     live we fall back to the cheap cross-backend list on a slow timer, which
 *     is what picks up an install started from another browser.
 *
 * The store accumulates across backends and is never cleared when the selected
 * backend changes: an install running on the machine you just switched away
 * from is still running, and the header count must keep saying so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInstall, Uuid } from '@comfy/shared';
import { ApiRequestError } from '../lib/api';
import type { ModelsApi } from '../lib/api-models';
import { isLive } from './catalogue';

/** Fast enough to feel live, slow enough not to hammer a downloading box. */
export const ACTIVE_POLL_MS = 3_000;
/** With nothing running there is nothing to watch; this only catches installs
 *  started elsewhere. */
export const IDLE_POLL_MS = 20_000;

export interface StartFailure {
  /** The catalogue ref that was refused, so the card can show it in place. */
  ref: string;
  message: string;
}

export interface InstallsState {
  /** Everything this session knows about, newest first. */
  installs: ModelInstall[];
  /** Only `queued` / `downloading`, across every backend. */
  live: ModelInstall[];
  /** True until the first adoption call has answered. */
  loading: boolean;
  /** Set when the install list itself could not be read. */
  error: string | null;
  /** Refs with a POST in flight, so a card can disable its own button. */
  starting: ReadonlySet<string>;
  startFailure: StartFailure | null;
  start: (backendId: Uuid, ref: string) => Promise<ModelInstall | null>;
  dismissFailure: () => void;
}

export interface UseInstallsOptions {
  api: ModelsApi;
  /** The backend whose install *history* to load. Live ones are global. */
  backendId: Uuid | null;
  /** False for a non-admin: every one of these routes would 403. */
  enabled: boolean;
}

export function useInstalls({ api, backendId, enabled }: UseInstallsOptions): InstallsState {
  const [byId, setById] = useState<Record<string, ModelInstall>>({});
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<ReadonlySet<string>>(() => new Set());
  const [startFailure, setStartFailure] = useState<StartFailure | null>(null);

  // The poll loop needs the current installs without being re-created every
  // time one of them moves, so the ref is the source of truth and the state is
  // its mirror for rendering.
  const store = useRef<Record<string, ModelInstall>>({});

  // Set by the poll effect: "there is something to watch now, come back
  // sooner". Without it, an install started while the loop was sitting on its
  // idle interval would show nothing for twenty seconds.
  const nudge = useRef<(() => void) | null>(null);

  const commit = useCallback((incoming: ModelInstall[]) => {
    if (incoming.length === 0) return;
    const next = { ...store.current };
    for (const install of incoming) next[install.id] = install;
    store.current = next;
    setById(next);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;

    const schedule = (delayMs: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), delayMs);
    };

    const tick = async () => {
      try {
        const live = Object.values(store.current).filter(isLive);

        if (first || live.length === 0) {
          // The adoption call, and the only thing that can discover an install
          // this page did not start.
          const active = await api.activeInstalls(controller.signal);
          if (stopped) return;
          commit(active);
        } else {
          // One request per live install: this route refreshes from the
          // backend on read, which is what moves queued -> downloading ->
          // complete. Settled installs are never re-read.
          const refreshed = await Promise.all(
            live.map((install) =>
              api
                .installStatus(install.backendId, install.id, controller.signal)
                // A single install that 404s (purged) must not stall the
                // others, so its previous state stands.
                .catch(() => install),
            ),
          );
          if (stopped) return;
          commit(refreshed);
        }

        if (first && backendId) {
          const history = await api.installHistory(backendId, controller.signal);
          if (stopped) return;
          commit(history);
        }

        if (!stopped) setError(null);
      } catch (cause) {
        if (stopped) return;
        setError(
          cause instanceof ApiRequestError && cause.status === 403
            ? 'Installing models is restricted to administrators.'
            : 'Could not read the install queue.',
        );
      } finally {
        if (!stopped) {
          if (first) {
            first = false;
            setLoading(false);
          }
          const stillLive = Object.values(store.current).some(isLive);
          schedule(stillLive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        }
      }
    };

    nudge.current = () => {
      if (!stopped) schedule(ACTIVE_POLL_MS);
    };
    void tick();

    return () => {
      stopped = true;
      nudge.current = null;
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, backendId, enabled, commit]);

  const start = useCallback(
    async (targetBackendId: Uuid, ref: string): Promise<ModelInstall | null> => {
      setStartFailure(null);
      setStarting((prev) => new Set(prev).add(ref));
      try {
        const install = await api.install(targetBackendId, ref);
        // Commit synchronously so the card flips to "Queued" on the click
        // rather than on the next poll — the poll may be twenty seconds away.
        commit([install]);
        nudge.current?.();
        return install;
      } catch (cause) {
        setStartFailure({
          ref,
          message:
            cause instanceof ApiRequestError
              ? cause.message
              : 'Could not start that install.',
        });
        return null;
      } finally {
        setStarting((prev) => {
          const next = new Set(prev);
          next.delete(ref);
          return next;
        });
      }
    },
    [api, commit],
  );

  const installs = useMemo(
    () =>
      Object.values(byId).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      ),
    [byId],
  );
  const live = useMemo(() => installs.filter(isLive), [installs]);

  const dismissFailure = useCallback(() => setStartFailure(null), []);

  return { installs, live, loading, error, starting, startFailure, start, dismissFailure };
}
