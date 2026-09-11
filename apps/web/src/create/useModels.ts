/**
 * Checkpoints and LoRAs for the pickers, plus the answer to "can I actually
 * generate with this one?".
 */
import { useEffect, useState } from 'react';
import type { JobKind, Model } from '@comfy/shared';
import { type CapabilityMap, modelsApi, modelSupported, workflowsApi } from '../lib/api-jobs';

export interface ModelsState {
  checkpoints: Model[];
  loras: Model[];
  capabilities: CapabilityMap;
  loading: boolean;
  error: string | null;
}

/**
 * What we hold before the first fetch resolves. `live: false` is load-bearing:
 * the picker must not draw a verdict from it, and `visibility.ts` will not hide
 * anything on the strength of a map that did not come from the server.
 */
const EMPTY_CAPABILITIES: CapabilityMap = { byFamily: {}, unknownFamily: [], live: false };

export function useModels(): ModelsState {
  const [state, setState] = useState<ModelsState>({
    checkpoints: [],
    loras: [],
    capabilities: EMPTY_CAPABILITIES,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        // Create offers only files held by an online, enabled backend.
        const [checkpoints, loras, capabilities] = await Promise.all([
          modelsApi.list({ type: 'checkpoint', availableOnly: true }, controller.signal),
          modelsApi.list({ type: 'lora', availableOnly: true }, controller.signal),
          workflowsApi.capabilities(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setState({
          checkpoints: checkpoints.models,
          loras: loras.models,
          capabilities,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : 'Could not load models.',
        }));
      }
    })();

    return () => controller.abort();
  }, []);

  return state;
}

export function supports(model: Model, kind: JobKind, capabilities: CapabilityMap): boolean {
  return modelSupported(model, kind, capabilities);
}
