/**
 * Every call the Create screen makes.
 *
 * Split out of `src/lib/api.ts` on purpose: the jobs and realtime surface does
 * not exist on the server yet (it is being built in parallel against
 * `API_CONTRACT.md`), so this module is the one place that knows the difference
 * between "the contract" and "what is actually deployed". Flipping to the real
 * API is a one-line change — see `MOCK` below — and nothing outside this file
 * imports the mock.
 *
 * The models endpoint, by contrast, is real today
 * (`apps/api/src/routes/models.ts`) and is called for real.
 */
import type {
  GenerationParams,
  Job,
  JobEvent,
  JobKind,
  JobStatus,
  Model,
  Upload,
} from '@comfy/shared';
import { ApiRequestError } from './api';
import { mockEventSource, mockJobs } from '../create/mockJobs';

/**
 * ---------------------------------------------------------------------------
 * THE FLIP.
 *
 * `jobs: true`  -> POST/GET/cancel and the event stream are served by
 *                  `src/create/mockJobs.ts`, in the browser.
 * `jobs: false` -> the real `POST /api/jobs`, `GET /api/jobs/:id`,
 *                  `POST /api/jobs/:id/cancel` and `WS /api/events`.
 *
 * Set `jobs` to `false` the day the orchestrator lands. That is the whole
 * change; every function below already has the real implementation written.
 * ---------------------------------------------------------------------------
 */
export const MOCK = {
  // Off: the orchestrator has landed and this screen talks to the real one.
  // The seam itself stays rather than being torn out — the component tests
  // drive the whole page through it, and the next screen built against an
  // endpoint that does not exist yet will want exactly this again.
  // `VITE_JOBS_MOCK=1` turns it back on for a dev server, the same seam the
  // library has, so the running and finished states can be seen without a GPU.
  jobs: import.meta.env.DEV && import.meta.env.VITE_JOBS_MOCK === '1',
};

const BASE = '/api';

/**
 * A local copy of `request()` from `src/lib/api.ts`. That module does not
 * export it and another workstream owns the file, so rather than edit it we
 * duplicate ten lines and reuse its error type — the one thing callers
 * actually depend on.
 */
async function request<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
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
    const error = (payload ?? {}) as { error?: string; message?: string };
    throw new ApiRequestError(
      response.status,
      error.error ?? 'error',
      error.message ?? 'Something went wrong.',
    );
  }
  return payload as T;
}

// ---------------------------------------------------------------- models

export interface ModelsResponse {
  models: Model[];
  /** Distinct `baseModel` values, for family filters. */
  families: string[];
}

export const modelsApi = {
  /**
   * `availableOnly` asks for models an *online* backend can load right now.
   * The picker wants that: a tile for a checkpoint that only exists on an
   * offline box is a tile that 409s `no_backend` on Generate.
   */
  list: (
    params: { type?: Model['type']; availableOnly?: boolean } = {},
    signal?: AbortSignal,
  ) => {
    const search = new URLSearchParams();
    if (params.type) search.set('type', params.type);
    if (params.availableOnly) search.set('availableOnly', 'true');
    const qs = search.toString();
    return request<ModelsResponse>(`/models${qs ? `?${qs}` : ''}`, { signal });
  },
};

// ---------------------------------------------------------------- capabilities

/**
 * Which model families we can actually compile a graph for.
 *
 * The server knows this — `apps/api/src/workflows/registry.ts` indexes every
 * template by `(capability, baseModel)` — but does not yet expose it. Until it
 * does, the picker has no way to tell a user that their Hunyuan checkpoint
 * cannot run txt2img except by letting them press Generate and collecting a
 * 501 `no_template`. That is the failure this exists to avoid.
 *
 * So: ask for the endpoint, and fall back to a mirror of the registry when it
 * 404s. The fallback is a *copy* and will rot; the endpoint is the fix, and the
 * moment it exists this starts using it with no other change here.
 */
export interface CapabilityMap {
  /** normalised family -> capabilities we hold a template for. */
  byFamily: Record<string, JobKind[]>;
  /**
   * Families whose template is a generic best-guess rather than a
   * hand-authored one, when the server says so (`isFallback` on a manifest).
   * Absent on a server that does not report it — treat an empty list as "we
   * were not told", not as "none".
   */
  fallbackFamilies?: string[];
  /** True when this came from the server rather than the fallback below. */
  live: boolean;
}

/** Mirrors `txt2imgSdxlTemplate.manifest.baseModels`. */
const FALLBACK_TEMPLATES: WorkflowManifest[] = [
  { capability: 'txt2img', baseModels: ['sdxl', 'SDXL 1.0', 'pony', 'illustrious'] },
];

/**
 * One template's manifest as `GET /workflows` reports it.
 *
 * `isFallback` marks a generic best-guess workflow — a template that will
 * probably run a checkpoint nobody has written a graph for. It is optional
 * because the endpoint may not report it yet; nothing here may require it.
 */
export interface WorkflowManifest {
  capability: JobKind;
  baseModels: string[];
  isFallback?: boolean;
}

/** The same fold `normalizeBaseModel()` does on the server. Must not diverge. */
export function normalizeFamily(baseModel: string): string {
  return baseModel.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toMap(manifests: WorkflowManifest[], live: boolean): CapabilityMap {
  const byFamily: Record<string, JobKind[]> = {};
  const fallbackFamilies = new Set<string>();
  const authored = new Set<string>();

  for (const manifest of manifests) {
    for (const base of manifest.baseModels) {
      const key = normalizeFamily(base);
      const kinds = byFamily[key] ?? (byFamily[key] = []);
      if (!kinds.includes(manifest.capability)) kinds.push(manifest.capability);
      // A family with any hand-authored template is not a fallback family,
      // whatever else also matches it.
      if (manifest.isFallback) fallbackFamilies.add(key);
      else authored.add(key);
    }
  }

  return {
    byFamily,
    fallbackFamilies: [...fallbackFamilies].filter((family) => !authored.has(family)),
    live,
  };
}

export const workflowsApi = {
  capabilities: async (signal?: AbortSignal): Promise<CapabilityMap> => {
    try {
      const { manifests } = await request<{ manifests: WorkflowManifest[] }>('/workflows', {
        signal,
      });
      return toMap(manifests, true);
    } catch {
      // A 404 means the endpoint is not built yet. Anything else — unreachable,
      // a 500 — is a real failure, but a Create screen that cannot answer "is
      // this model runnable" is still usable, so degrade to the fallback in
      // both cases rather than blanking the picker.
      return toMap(FALLBACK_TEMPLATES, false);
    }
  },
};

/** Can `model` be generated with, for this capability? */
export function modelSupported(
  model: Pick<Model, 'baseModel'>,
  kind: JobKind,
  capabilities: CapabilityMap,
): boolean {
  return modelKinds(model, capabilities).includes(kind);
}

/**
 * Everything this model's family *can* do, whatever we are asking for now.
 *
 * This is what turns "No template" into a sentence: a checkpoint blocked for
 * txt2img because it is a video model is a different problem from one nobody
 * has written any graph for, and only the first has a fix the user can reach.
 */
export function modelKinds(
  model: Pick<Model, 'baseModel'>,
  capabilities: CapabilityMap,
): JobKind[] {
  if (!model.baseModel) return [];
  return capabilities.byFamily[normalizeFamily(model.baseModel)] ?? [];
}

/** Is this family only runnable through a generic best-guess template? */
export function isFallbackFamily(
  model: Pick<Model, 'baseModel'>,
  capabilities: CapabilityMap,
): boolean {
  if (!model.baseModel) return false;
  return (capabilities.fallbackFamilies ?? []).includes(normalizeFamily(model.baseModel));
}

// ---------------------------------------------------------------- readiness

/**
 * `GET /backends/:id/readiness?modelId&capability` — can this model actually
 * run this kind of job on this machine, and if not, what would fix it.
 *
 * This is the endpoint that makes the model picker honest. The capability map
 * above is a *family* answer derived from `/workflows`, which is not built yet,
 * so it falls back to a hardcoded mirror that knows only `txt2img` for SDXL.
 * On a box whose other two checkpoints are video models that fallback is wrong
 * in the most visible way possible: switch to Video and every tile says "No
 * template" even though the server holds `txt2vid-ltxv` and would happily
 * compile it. Readiness asks the server the exact question the user is asking
 * — this model, this kind of job, right now — and answers with the truth,
 * including the case that no family-level answer can express: the template
 * exists, and something on the backend is missing or misfiled.
 *
 * Three outcomes, and a fourth for "we could not ask":
 *   ready        — selectable.
 *   blocked      — the workflow exists; the backend is not set up for it. This
 *                  is the one worth reading, because it has a fix.
 *   no-template  — nobody has written a graph for this family and capability.
 *   unknown      — the endpoint is unreachable or not deployed. Callers must
 *                  fall back to the capability map rather than blocking a model
 *                  because we failed to ask about it.
 */
export type ReadinessState = 'ready' | 'blocked' | 'no-template' | 'unknown';

export interface ModelReadiness {
  state: ReadinessState;
  /** "Text to video (LTX-Video)" — what would run, when something would. */
  templateLabel: string | null;
  isFallback: boolean;
  /** One sentence naming what is wrong, for the tile's tooltip and the note. */
  summary: string | null;
  /** What a person would have to do about it, in the server's own words. */
  steps: string[];
}

const UNKNOWN_READINESS: ModelReadiness = {
  state: 'unknown',
  templateLabel: null,
  isFallback: false,
  summary: null,
  steps: [],
};

/** The slice of the readiness payload this screen reads. It sends much more. */
interface ReadinessPayload {
  templateLabel?: string | null;
  isFallback?: boolean;
  ready?: boolean;
  requirements?: {
    id: string;
    label: string;
    status?: string;
    misfiled?: { instruction?: string } | null;
  }[];
  manualSteps?: string[];
  installable?: { name?: string; filename?: string }[];
}

export const readinessApi = {
  async get(
    backendId: string,
    modelId: string,
    capability: JobKind,
    signal?: AbortSignal,
  ): Promise<ModelReadiness> {
    const search = new URLSearchParams({ modelId, capability });
    try {
      const { readiness } = await request<{ readiness: ReadinessPayload }>(
        `/backends/${backendId}/readiness?${search}`,
        { signal },
      );
      return toReadiness(readiness);
    } catch (error) {
      // 400 `bad_request` is the server saying "no workflow exists for this
      // family and capability" — a real, useful answer, not a failure. Anything
      // else means we could not ask, which is a different thing and must not be
      // rendered as "this model cannot do it".
      if (error instanceof ApiRequestError && error.status === 400) {
        return { ...UNKNOWN_READINESS, state: 'no-template', summary: error.message };
      }
      if (signal?.aborted) throw error;
      return UNKNOWN_READINESS;
    }
  },
};

function toReadiness(payload: ReadinessPayload): ModelReadiness {
  const templateLabel = payload.templateLabel ?? null;
  const isFallback = payload.isFallback === true;
  if (payload.ready) {
    return { state: 'ready', templateLabel, isFallback, summary: null, steps: [] };
  }

  const unmet = (payload.requirements ?? []).filter(
    (requirement) => requirement.status && requirement.status !== 'ok',
  );
  // The server's own instruction is always better than anything assembled
  // here — it knows the folder, the filename and the machine.
  const steps = [
    ...(payload.manualSteps ?? []),
    ...(payload.installable ?? [])
      .map((offer) => offer.name ?? offer.filename)
      .filter((name): name is string => Boolean(name))
      .map((name) => `Install ${name}.`),
  ];

  return {
    state: 'blocked',
    templateLabel,
    isFallback,
    summary: unmet.length > 0 ? summarise(unmet) : 'the backend is not set up for it yet.',
    steps,
  };
}

/** "the checkpoint is in the wrong folder, and the T5 text encoder is missing." */
function summarise(
  unmet: { label: string; status?: string }[],
): string {
  const phrases = unmet.map((requirement) => {
    // Mid-sentence, so the label drops its capital — unless it starts with an
    // acronym, where lowercasing turns "T5 text encoder" into "t5 text
    // encoder" and makes the product look like it cannot spell.
    const label = requirement.label;
    const what = /^[A-Z]{2,}|^[A-Z]\d/.test(label)
      ? label
      : label.charAt(0).toLowerCase() + label.slice(1);
    if (requirement.status === 'misfiled') return `the ${what} is in a folder ComfyUI cannot load it from`;
    return `the ${what} is not installed`;
  });
  if (phrases.length === 1) return `${phrases[0]}.`;
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}.`;
}

// ---------------------------------------------------------------- jobs

export const jobsApi = {
  /** `POST /jobs` -> 202. Validates, compiles and persists; does not dispatch. */
  create: (params: GenerationParams, signal?: AbortSignal): Promise<{ job: Job }> =>
    MOCK.jobs
      ? mockJobs.create(params)
      : request<{ job: Job }>('/jobs', { method: 'POST', body: { params }, signal }),

  /**
   * The reload path. A socket only tells you what happened while you were
   * listening, so the stage refetches on mount rather than assuming.
   */
  get: (id: string, signal?: AbortSignal): Promise<{ job: Job }> =>
    MOCK.jobs ? mockJobs.get(id) : request<{ job: Job }>(`/jobs/${id}`, { signal }),

  list: (
    params: { limit?: number; status?: JobStatus } = {},
    signal?: AbortSignal,
  ): Promise<{ jobs: Job[] }> => {
    if (MOCK.jobs) return mockJobs.list(params);
    const search = new URLSearchParams();
    if (params.limit) search.set('limit', String(params.limit));
    if (params.status) search.set('status', params.status);
    const qs = search.toString();
    return request<{ jobs: Job[] }>(`/jobs${qs ? `?${qs}` : ''}`, { signal });
  },

  cancel: (id: string, signal?: AbortSignal): Promise<{ job: Job }> =>
    MOCK.jobs
      ? mockJobs.cancel(id)
      : request<{ job: Job }>(`/jobs/${id}/cancel`, { method: 'POST', signal }),
};

// ---------------------------------------------------------------- realtime

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface EventStreamHandlers {
  onEvent: (event: JobEvent) => void;
  onConnectionChange?: (state: ConnectionState) => void;
}

/**
 * Subscribe to `WS /api/events`, reconnecting with capped exponential backoff
 * plus jitter. Returns an unsubscribe.
 *
 * Two things this deliberately does *not* do. It does not validate an unknown
 * frame into anything: an unrecognised `type` is handed to `onEvent` as-is and
 * the reducer ignores it, which is what the contract asks of clients. And it
 * does not treat a close as an error — a self-hosted API restarts, and the
 * honest response is a quiet reconnect, not a red banner.
 */
export function subscribeToEvents(handlers: EventStreamHandlers): () => void {
  if (MOCK.jobs) return mockEventSource(handlers);

  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    handlers.onConnectionChange?.('connecting');
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${window.location.host}${BASE}/events`);

    socket.onopen = () => {
      attempt = 0;
      handlers.onConnectionChange?.('open');
    };
    socket.onmessage = (message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return; // Not JSON. Nothing to do but keep listening.
      }
      if (frame && typeof frame === 'object' && 'type' in frame) {
        handlers.onEvent(frame as JobEvent);
      }
    };
    socket.onclose = () => {
      handlers.onConnectionChange?.('closed');
      if (stopped) return;
      timer = setTimeout(connect, backoffMs(attempt++));
    };
    socket.onerror = () => socket?.close();
  };

  connect();

  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}

/** 0.5s, 1s, 2s, 4s, 8s, capped at 15s, +/-25% jitter so N tabs do not sync. */
export function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 15_000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

// ---------------------------------------------------------------- uploads

/**
 * Dropping a file to use as a starting image.
 *
 * Deliberately not routed through `request()`: that helper sets a JSON content
 * type and serialises the body, and a multipart upload needs the browser to set
 * the boundary itself. Passing a FormData with an explicit content-type header
 * produces a request the server cannot parse.
 */
export const uploadsApi = {
  async create(file: File, signal?: AbortSignal): Promise<{ upload: Upload }> {
    const body = new FormData();
    body.append('file', file);

    const res = await fetch(`${BASE}/uploads`, {
      method: 'POST',
      credentials: 'include',
      body,
      ...(signal ? { signal } : {}),
    });

    if (!res.ok) {
      // The server's message is the useful one — it distinguishes "that isn't
      // an image we can read" from "that file is too large", and both are
      // things the person who just dropped a file needs to be told.
      const problem = (await res.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      throw new ApiRequestError(
        res.status,
        problem?.error ?? 'upload_failed',
        problem?.message ?? `Upload failed (${res.status})`,
      );
    }

    return (await res.json()) as { upload: Upload };
  },
};
