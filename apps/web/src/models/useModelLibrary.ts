/**
 * The backends and the installed models — the two lists the whole screen is
 * built on, loaded together because neither is useful alone: a model's
 * `backendIds` mean nothing without the names to resolve them to.
 *
 * Both routes are `requireAuth`, not `requireAdmin`. Seeing what is installed
 * is not an operator privilege; only installing is. That is why this hook has
 * no `enabled` flag while `useCatalogue` and `useInstalls` do.
 *
 * `refresh` exists for one reason: an install that completes has put a new
 * file on a machine, and the installed list is stale until it is re-read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend, Model, Uuid } from '@comfy/shared';
import type { ModelsApi } from '../lib/api-models';

export interface ModelLibraryState {
  backends: Backend[];
  models: Model[];
  /** Folded family keys from the API, for the installed view's chips. */
  families: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Backend name for an id, for the "which machines have this" chips. */
  backendName: (id: Uuid) => string;
}

export function useModelLibrary(api: ModelsApi): ModelLibraryState {
  const [backends, setBackends] = useState<Backend[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [families, setFamilies] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Names outlive the list they came from: a refresh must not make a chip
  // flicker to a raw uuid while the request is in the air.
  const names = useRef<Map<Uuid, string>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;

    void (async () => {
      try {
        const [backendList, installed] = await Promise.all([
          api.backends(controller.signal),
          api.installed(controller.signal),
        ]);
        if (stopped) return;
        for (const backend of backendList) names.current.set(backend.id, backend.name);
        setBackends(backendList);
        setModels(installed.models);
        setFamilies(installed.families);
        setError(null);
      } catch {
        if (!stopped) setError('Could not load your backends and their models.');
      } finally {
        if (!stopped) setLoading(false);
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [api, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const backendName = useCallback(
    (id: Uuid) => names.current.get(id) ?? `${id.slice(0, 8)}…`,
    [],
  );

  return { backends, models, families, loading, error, refresh, backendName };
}
