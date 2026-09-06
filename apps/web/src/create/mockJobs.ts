/**
 * A fake orchestrator, in the browser.
 *
 * `POST /api/jobs` and `WS /api/events` do not exist yet — they are being built
 * in parallel against API_CONTRACT.md. Rather than build the Create screen
 * blind, this module implements that contract: it accepts `GenerationParams`,
 * returns a `queued` `Job`, then emits `JobEvent` frames on a timer exactly as
 * the contract says the socket will, including live-preview frames and a final
 * `job.complete` carrying `Asset`s.
 *
 * It is imported only by `src/lib/api-jobs.ts`, and only while `MOCK.jobs` is
 * true. Deleting this file is the second half of switching to the real API.
 *
 * Two behaviours here are not decoration, because the screen has to handle them
 * and would otherwise never be exercised:
 *  - jobs are persisted to `sessionStorage`, so a reload finds a job still
 *    running and `GET /jobs/:id` returns real state;
 *  - one progress frame in every run is delivered *out of order*, so the
 *    reducer's monotonicity guard is live-tested and not only unit-tested.
 */
import type {
  Asset,
  GenerationParams,
  Job,
  JobEvent,
  JobProgress,
  JobStatus,
} from '@comfy/shared';
import type { EventStreamHandlers } from '../lib/api-jobs';

const STORAGE_KEY = 'comfy.mock.jobs.v1';
const TICK_MS = 320;
const QUEUE_TICKS = 3;

const listeners = new Set<(event: JobEvent) => void>();
const jobs = new Map<string, Job>();
const timers = new Map<string, ReturnType<typeof setInterval>>();

function uuid(): string {
  // `crypto.randomUUID` is unavailable over plain http on some browsers, and
  // this box is served over http on the LAN.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function emit(event: JobEvent) {
  for (const listener of [...listeners]) listener(event);
}

function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...jobs.values()]));
  } catch {
    // Private mode, or storage full. The mock still works in memory.
  }
}

function restore() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const job of JSON.parse(raw) as Job[]) jobs.set(job.id, job);
  } catch {
    /* ignore */
  }
}
restore();

/** A deterministic pair of hues, so the same seed always paints the same tile. */
function hues(seed: number, index: number): [number, number] {
  const h = (seed * 47 + index * 137) % 360;
  return [h, (h + 58) % 360];
}

function gradient(seed: number, index: number, width: number, height: number, blur: number) {
  const [a, b] = hues(seed, index);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><radialGradient id="g" cx="28%" cy="18%" r="115%">
      <stop offset="0%" stop-color="hsl(${a} 92% 66%)"/>
      <stop offset="45%" stop-color="hsl(${b} 62% 34%)"/>
      <stop offset="100%" stop-color="hsl(${(b + 200) % 360} 55% 9%)"/>
    </radialGradient>
    <filter id="b"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>
    <rect width="100%" height="100%" fill="url(#g)" filter="url(#b)"/>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function seedOf(params: GenerationParams): number {
  return params.advanced?.seed ?? 1;
}

function newJob(params: GenerationParams): Job {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    userId: 'mock-user',
    kind: params.kind,
    status: 'queued',
    queuePosition: 0,
    params,
    backendId: null,
    progress: {
      step: null,
      totalSteps: null,
      frame: null,
      totalFrames: null,
      fraction: 0,
      etaSeconds: null,
      previewUrl: null,
    },
    error: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    assets: [],
  };
}

function totalSteps(params: GenerationParams): number {
  return params.advanced?.steps ?? { fast: 16, balanced: 28, high: 45 }[params.quality];
}

function assetsFor(job: Job): Asset[] {
  const seed = seedOf(job.params);
  const { width, height } = dimensions(job.params);
  return Array.from({ length: job.params.batchSize }, (_, index) => ({
    id: uuid(),
    jobId: job.id,
    kind: 'image' as const,
    url: gradient(seed, index, width, height, 0),
    thumbUrl: gradient(seed, index, 160, 160, 0),
    width,
    height,
    duration: null,
    starred: false,
    createdAt: new Date().toISOString(),
  }));
}

/** The SDXL buckets from `apps/api/src/workflows/presets.ts`. */
function dimensions(params: GenerationParams): { width: number; height: number } {
  return {
    '1:1': { width: 1024, height: 1024 },
    '3:2': { width: 1216, height: 832 },
    '2:3': { width: 832, height: 1216 },
    '16:9': { width: 1344, height: 768 },
    '9:16': { width: 768, height: 1344 },
  }[params.aspect];
}

function setStatus(job: Job, status: JobStatus, queuePosition: number | null) {
  job.status = status;
  job.queuePosition = queuePosition;
  if (status === 'running' && !job.startedAt) job.startedAt = new Date().toISOString();
  persist();
  emit({ type: 'job.status', jobId: job.id, status, queuePosition });
}

function run(job: Job) {
  if (timers.has(job.id)) return;
  const steps = totalSteps(job.params);
  const seed = seedOf(job.params);
  let tick = 0;
  let lateFrame: JobProgress | null = null;

  const timer = setInterval(() => {
    tick += 1;

    if (tick <= QUEUE_TICKS) {
      const position = QUEUE_TICKS - tick;
      if (position > 0) {
        setStatus(job, 'queued', position);
      } else {
        setStatus(job, 'dispatched', null);
      }
      return;
    }

    const step = Math.min(steps, tick - QUEUE_TICKS);
    const fraction = step / steps;
    const progress: JobProgress = {
      step,
      totalSteps: steps,
      frame: null,
      totalFrames: null,
      fraction,
      etaSeconds: Math.round(((steps - step) * TICK_MS) / 1000),
      // A live preview appears a few steps in, as a real backend's does, and
      // sharpens as it goes.
      previewUrl: step >= 3 ? gradient(seed, 0, 512, 512, Math.max(0, 14 - step)) : null,
    };

    if (job.status !== 'running') setStatus(job, 'running', null);

    // Hold one frame back and deliver it after the next, so the reducer's
    // out-of-order guard runs in the real app and not only in a test.
    if (step === Math.floor(steps / 2)) {
      lateFrame = progress;
      return;
    }
    job.progress = progress;
    persist();
    emit({ type: 'job.progress', jobId: job.id, progress });
    if (lateFrame) {
      emit({ type: 'job.progress', jobId: job.id, progress: lateFrame });
      lateFrame = null;
    }

    if (step >= steps) {
      clearInterval(timer);
      timers.delete(job.id);
      setStatus(job, 'uploading', null);
      setTimeout(() => {
        const assets = assetsFor(job);
        job.assets = assets;
        job.status = 'complete';
        job.finishedAt = new Date().toISOString();
        job.progress = { ...job.progress, fraction: 1, etaSeconds: 0, previewUrl: null };
        persist();
        emit({ type: 'job.complete', jobId: job.id, assets });
      }, 500);
    }
  }, TICK_MS);

  timers.set(job.id, timer);
}

export const mockJobs = {
  async create(params: GenerationParams): Promise<{ job: Job }> {
    await delay(120);
    const job = newJob(params);
    jobs.set(job.id, job);
    persist();
    emit({ type: 'job.created', job });
    run(job);
    return { job: structuredClone(job) };
  },

  async get(id: string): Promise<{ job: Job }> {
    await delay(60);
    const job = jobs.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    // Resuming after a reload: the timer died with the page, the row did not.
    if (!['complete', 'failed', 'cancelled'].includes(job.status)) run(job);
    return { job: structuredClone(job) };
  },

  async list({ limit = 20 }: { limit?: number; status?: JobStatus } = {}): Promise<{ jobs: Job[] }> {
    await delay(60);
    const all = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { jobs: all.slice(0, limit).map((job) => structuredClone(job)) };
  },

  async cancel(id: string): Promise<{ job: Job }> {
    await delay(60);
    const job = jobs.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    const timer = timers.get(id);
    if (timer) clearInterval(timer);
    timers.delete(id);
    job.status = 'cancelled';
    job.queuePosition = null;
    job.finishedAt = new Date().toISOString();
    job.progress = { ...job.progress, previewUrl: null };
    persist();
    emit({ type: 'job.status', jobId: id, status: 'cancelled', queuePosition: null });
    return { job: structuredClone(job) };
  },
};

/** Stands in for the WebSocket. Same signature, same unsubscribe. */
export function mockEventSource(handlers: EventStreamHandlers): () => void {
  const listener = (event: JobEvent) => handlers.onEvent(event);
  listeners.add(listener);
  handlers.onConnectionChange?.('open');
  return () => {
    listeners.delete(listener);
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
