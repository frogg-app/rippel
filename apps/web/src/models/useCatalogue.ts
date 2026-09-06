/**
 * One backend's install catalogue.
 *
 * The catalogue is a property of the *backend*, not of the product: it is what
 * that machine's transport is willing to install, and a machine with no
 * transport has none at all. So "there is no catalogue here" is a first-class
 * state with its own message rather than an error or an empty grid — the API
 * answers 501 with the exact sentence an operator needs ("Install
 * ComfyUI-Manager into the backend's custom_nodes and restart ComfyUI"), and
 * throwing that away in favour of "Something went wrong" would replace the
 * answer with a shrug.
 *
 * The one piece of machinery beyond that is the **fill-in poll**. Preview
 * images and licences are resolved from the models' own pages server-side, and
 * the first read of a catalogue nobody has looked at yet comes back with none
 * of them and a `pending` count instead. Rather than making the operator wait
 * ~50 seconds for a grid, the first answer is painted immediately and re-read a
 * few times while the server catches up — silently, in place, because the
 * entries themselves do not change. It stops the moment `pending` hits zero,
 * which it does permanently: the cache survives restarts, so the second visit
 * to a backend polls nothing at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendStatus, ModelCatalogEntry, Uuid } from '@comfy/shared';
import { ApiRequestError } from '../lib/api';
import type { ModelsApi } from '../lib/api-models';

export type CatalogueState =
  /** No backend to ask — there are none registered. */
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready';
      entries: ModelCatalogEntry[];
      /** Model pages still being resolved server-side; 0 when nothing is. */
      pending: number;
    }
  /** 501: the backend has no install mechanism. `message` is the API's. */
  | { kind: 'unsupported'; message: string }
  /** 403: not an admin. */
  | { kind: 'forbidden'; message: string }
  /** The backend is down; asking it would only time out. */
  | { kind: 'offline'; message: string }
  | { kind: 'error'; message: string };

export interface CatalogueResult {
  state: CatalogueState;
  reload: () => void;
}

/** Long enough that a sweep makes visible progress between reads. */
const FILL_IN_POLL_MS = 6_000;
/** ~72 seconds of patience: the whole 132-page sweep took 49s on the real box. */
const MAX_FILL_IN_POLLS = 12;

export interface UseCatalogueOptions {
  api: ModelsApi;
  backendId: Uuid | null;
  backendName: string | null;
  backendStatus: BackendStatus | null;
  /** False for a non-admin: the route would 403 and there is nothing to try. */
  enabled: boolean;
}

export function useCatalogue({
  api,
  backendId,
  backendName,
  backendStatus,
  enabled,
}: UseCatalogueOptions): CatalogueResult {
  const [state, setState] = useState<CatalogueState>({ kind: 'idle' });
  const [nonce, setNonce] = useState(0);

  /**
   * The last good answer for a backend, so a *refresh* is silent.
   *
   * A completed install reloads this list to pick up the new `installed` flag.
   * Dropping to a skeleton grid for that would throw away the operator's scroll
   * position and their filters' results at the exact moment they were watching
   * something finish, so a reload of the same backend keeps painting what it
   * already had until the new answer lands.
   */
  const shown = useRef<{ backendId: Uuid; entries: ModelCatalogEntry[] } | null>(null);

  /**
   * How many fill-in polls this backend has had. Bounded: the sweep takes about
   * a minute on a catalogue nobody has read before, and a page left open all
   * day must not keep asking for something that is never going to arrive.
   */
  const polls = useRef<{ backendId: Uuid | null; count: number }>({ backendId: null, count: 0 });

  useEffect(() => {
    if (!backendId) {
      setState({ kind: 'idle' });
      return;
    }
    if (!enabled) {
      setState({
        kind: 'forbidden',
        message: 'Only an administrator can see what a backend is able to install.',
      });
      return;
    }
    if (backendStatus === 'offline') {
      // Not a guess about the transport: an offline backend cannot answer at
      // all, and the probe behind this route waits 15 seconds to find that
      // out. Saying so immediately is both faster and more accurate.
      setState({
        kind: 'offline',
        message: `${backendName ?? 'This backend'} is offline, so it cannot say what it can install. Start ComfyUI on it and this list will fill in.`,
      });
      return;
    }

    const controller = new AbortController();
    let stopped = false;
    setState(
      shown.current?.backendId === backendId
        ? { kind: 'ready', entries: shown.current.entries, pending: 0 }
        : { kind: 'loading' },
    );

    api
      .catalogue(backendId, controller.signal)
      .then(({ entries, pending }) => {
        if (stopped) return;
        shown.current = { backendId, entries };
        setState({ kind: 'ready', entries, pending });
      })
      .catch((cause: unknown) => {
        if (stopped) return;
        // A failed refresh invalidates the cached answer: a backend that has
        // just lost its transport must not keep showing the catalogue it had.
        shown.current = null;
        if (cause instanceof ApiRequestError) {
          // 501 is the whole reason this state machine exists. The message is
          // rendered verbatim because it names the fix.
          if (cause.status === 501) return setState({ kind: 'unsupported', message: cause.message });
          if (cause.status === 403) return setState({ kind: 'forbidden', message: cause.message });
          return setState({ kind: 'error', message: cause.message });
        }
        setState({ kind: 'error', message: 'Could not read this backend’s catalogue.' });
      });

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [api, backendId, backendName, backendStatus, enabled, nonce]);

  // The fill-in poll. Deliberately a second effect: it is about the *answer*,
  // not about the request, and folding it into the fetch above would restart
  // the fetch every time its own result arrived.
  useEffect(() => {
    if (state.kind !== 'ready' || state.pending === 0 || !backendId) return;
    if (polls.current.backendId !== backendId) polls.current = { backendId, count: 0 };
    if (polls.current.count >= MAX_FILL_IN_POLLS) return;

    const timer = setTimeout(() => {
      polls.current.count += 1;
      setNonce((n) => n + 1);
    }, FILL_IN_POLL_MS);
    return () => clearTimeout(timer);
  }, [state, backendId]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { state, reload };
}
