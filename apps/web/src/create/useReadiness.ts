/**
 * "Can this model actually make what I am about to ask for?" — asked of the
 * server, per model, for the capability the form would submit right now.
 *
 * The Create screen used to answer this from a *family* map built out of
 * `GET /workflows`. That endpoint is not deployed, so the map fell back to a
 * hardcoded mirror that knows one thing: SDXL can do txt2img. On this box —
 * one SDXL checkpoint and two video checkpoints — that made the Video tab a
 * dead end: every tile read "No template", including the LTX-Video model the
 * server holds two templates for. Switching tabs looked like it did nothing.
 *
 * So the question is asked properly. `GET /backends/:id/readiness` answers it
 * for a specific model on a specific backend, and distinguishes the two cases
 * a family map cannot: "no workflow exists for this" from "the workflow exists
 * and the machine is missing a file" — the second being the one with a fix.
 *
 * Three rules make this cheap enough to do on every toggle:
 *
 *  1. **Derive, never re-request the model list.** `/models` is fetched once by
 *     `useModels`. Switching Image/Video changes which capability we ask about,
 *     not which models exist.
 *  2. **Cache by (backend, model, capability), for the session.** The answer
 *     only changes when someone installs or moves a file on the backend, so
 *     flipping the toggle back and forth issues no requests at all after the
 *     first pass.
 *  3. **A failure to ask is not an answer.** An unreachable endpoint yields
 *     `unknown`, which is never cached and never blocks a model; the caller
 *     falls back to the capability map, which is what the screen did before
 *     this existed.
 */
import { useEffect, useMemo, useState } from 'react';
import type { JobKind, Model } from '@comfy/shared';
import {
  type CapabilityMap,
  type ModelReadiness,
  modelSupported,
  readinessApi,
} from '../lib/api-jobs';

/** The same job, in the other tab: txt2img <-> txt2vid, img2img <-> img2vid. */
export function counterpartKind(kind: JobKind): JobKind | null {
  switch (kind) {
    case 'txt2img':
      return 'txt2vid';
    case 'txt2vid':
      return 'txt2img';
    case 'img2img':
      return 'img2vid';
    case 'img2vid':
      return 'img2img';
    default:
      return null;
  }
}

export interface ReadinessMap {
  /** By model id, for the capability the form would submit now. */
  here: Record<string, ModelReadiness>;
  /** By model id, for the same job in the other mode — "would Video run this?" */
  other: Record<string, ModelReadiness>;
  /**
   * True until the server has answered for this exact (models, capability).
   *
   * Derived during render, not set by an effect — an effect runs *after* the
   * first paint, so a flag raised there leaves one frame in which the screen
   * confidently renders the fallback map's guesses as verdicts. That frame was
   * the flash: five of six checkpoints badged "No template", corrected a few
   * hundred milliseconds later.
   */
  loading: boolean;
}

const EMPTY: ReadinessMap = { here: {}, other: {}, loading: false };

/** `${backendId}|${modelId}|${capability}` -> what the server said. */
const cache = new Map<string, ModelReadiness>();

function cacheKey(backendId: string, modelId: string, capability: JobKind): string {
  return `${backendId}|${modelId}|${capability}`;
}

async function probe(
  model: Model,
  capability: JobKind,
  signal: AbortSignal,
): Promise<ModelReadiness | null> {
  // Ask the backend that actually holds the checkpoint. A model on no online
  // backend has nobody to ask, and readiness is not the screen that reports
  // that — the picker already shows what is installed where.
  const backendId = model.backendIds[0];
  if (!backendId) return null;

  const key = cacheKey(backendId, model.id, capability);
  const cached = cache.get(key);
  if (cached) return cached;

  const readiness = await readinessApi.get(backendId, model.id, capability, signal);
  // `unknown` means we could not ask. Caching it would make one dropped request
  // look like a permanent verdict for the rest of the session.
  if (readiness.state !== 'unknown') cache.set(key, readiness);
  return readiness;
}

export function useReadiness(models: Model[], kind: JobKind): ReadinessMap {
  const [map, setMap] = useState<ReadinessMap>(EMPTY);
  // Which (models, capability) the state in `map` is an answer *to*. Anything
  // else means we have not asked yet, whatever `map` happens to contain.
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);

  // The identity of the model list, not the array: `useModels` hands back a new
  // array on every render and we must not probe on every render.
  const modelKey = useMemo(() => models.map((model) => model.id).join(','), [models]);

  useEffect(() => {
    if (models.length === 0) {
      setMap(EMPTY);
      setAnsweredFor(`|${kind}`);
      return;
    }
    const controller = new AbortController();
    const other = counterpartKind(kind);

    void (async () => {
      const [hereResults, otherResults] = await Promise.all([
        Promise.all(models.map((model) => probe(model, kind, controller.signal).catch(() => null))),
        other
          ? Promise.all(
              models.map((model) => probe(model, other, controller.signal).catch(() => null)),
            )
          : Promise.resolve([]),
      ]);
      if (controller.signal.aborted) return;

      const collect = (results: (ModelReadiness | null)[]) => {
        const record: Record<string, ModelReadiness> = {};
        results.forEach((readiness, index) => {
          const model = models[index];
          if (model && readiness) record[model.id] = readiness;
        });
        return record;
      };

      setMap({ here: collect(hereResults), other: collect(otherResults), loading: false });
      setAnsweredFor(`${modelKey}|${kind}`);
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, kind]);

  // The flag the screen actually reads. Note this is true on the very first
  // render, before the effect above has run at all, which is the whole point.
  const loading = answeredFor !== `${modelKey}|${kind}`;
  return useMemo(() => ({ ...map, loading }), [map, loading]);
}

/** Test seam: forget what the server said. */
export function resetReadinessCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------- decisions

/**
 * Can we submit this model for this capability?
 *
 * Readiness wins when the server answered, because it is the specific truth:
 * it knows whether the family has a template *and* whether the machine can
 * load it. When the endpoint could not be reached the family map is the
 * fallback — exactly what this screen did before readiness existed. A model is
 * never blocked because we failed to ask about it.
 */
export function isRunnable(
  model: Model,
  kind: JobKind,
  capabilities: CapabilityMap,
  readiness: ReadinessMap,
): boolean {
  const answer = readiness.here[model.id];
  if (answer && answer.state !== 'unknown') return answer.state === 'ready';
  return modelSupported(model, kind, capabilities);
}

/**
 * Would the *other* tab run this model?
 *
 * "This is a video model — switch tabs" is the most useful thing the picker can
 * say on this box, and saying it wrongly is worse than not saying it. A
 * template that exists but is blocked on a missing file still counts: the claim
 * being made is that the model belongs to the other mode, and it does.
 */
export function runsInOtherMode(model: Model, readiness: ReadinessMap): boolean {
  const answer = readiness.other[model.id];
  return answer?.state === 'ready' || answer?.state === 'blocked';
}
