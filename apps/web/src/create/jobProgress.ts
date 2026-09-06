/**
 * Applying `JobEvent` frames to the job the stage is showing.
 *
 * A WebSocket gives no ordering guarantee across a reconnect, and the contract
 * explicitly reserves the right to add event types. Both of those turn into
 * visible nonsense if handled naively: a late `job.progress` rewinds the bar, a
 * stale `job.status` un-completes a finished job, and an unknown `type` throws.
 * So this is a pure reducer with the rules written down, and it is unit-tested
 * against out-of-order and unknown frames.
 */
import type { Asset, Job, JobEvent, JobProgress, JobStatus } from '@comfy/shared';

/** Lifecycle order, from PLAN.md. Terminal states share the top rank. */
const STATUS_RANK: Record<JobStatus, number> = {
  queued: 0,
  dispatched: 1,
  running: 2,
  uploading: 3,
  complete: 4,
  failed: 4,
  cancelled: 4,
};

export const TERMINAL_STATUSES: readonly JobStatus[] = ['complete', 'failed', 'cancelled'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function emptyProgress(): JobProgress {
  return {
    step: null,
    totalSteps: null,
    frame: null,
    totalFrames: null,
    fraction: 0,
    etaSeconds: null,
    previewUrl: null,
  };
}

/**
 * Apply one frame.
 *
 * Returns the *same* job object when the frame changes nothing, so React can
 * skip a render, and so "we ignored that" is observable in a test.
 *
 * Rules, in order:
 *  1. A frame for another job is not ours. Ignore it. (`job.created` is the
 *     exception — the caller decides whether to adopt a new job; see
 *     `adoptCreated`.)
 *  2. Nothing moves a terminal job. `complete` is the end; a straggling
 *     `progress` frame from before the completion must not resurrect it.
 *  3. Status only moves forward through the lifecycle.
 *  4. Progress only moves forward *within a status*: a lower `fraction` is a
 *     reordered frame. A preview URL is taken from any in-order frame, since a
 *     newer preview is always better than an older one.
 *  5. An unrecognised `type` leaves the job alone.
 */
export function applyJobEvent(job: Job | null, event: JobEvent | { type: string }): Job | null {
  if (!job) return job;
  const frame = event as JobEvent;

  switch (frame.type) {
    case 'job.created':
      // Only meaningful for the job we are already showing — a re-delivery
      // after a reconnect. A *different* job's creation is the caller's
      // business, not the reducer's.
      return frame.job.id === job.id ? frame.job : job;

    case 'job.status': {
      if (frame.jobId !== job.id) return job;
      if (isTerminal(job.status)) return job;
      if (STATUS_RANK[frame.status] < STATUS_RANK[job.status]) return job;
      if (frame.status === job.status && frame.queuePosition === job.queuePosition) return job;
      return { ...job, status: frame.status, queuePosition: frame.queuePosition };
    }

    case 'job.progress': {
      if (frame.jobId !== job.id) return job;
      if (isTerminal(job.status)) return job;
      const next = mergeProgress(job.progress, frame.progress);
      if (next === job.progress) return job;
      // A progress frame is also proof the job is running: the orchestrator can
      // reorder a `status` and a `progress`, and a bar that advances under the
      // word "Queued" is worse than inferring the obvious.
      const status: JobStatus = STATUS_RANK[job.status] < STATUS_RANK.running ? 'running' : job.status;
      return { ...job, status, queuePosition: status === 'queued' ? job.queuePosition : null, progress: next };
    }

    case 'job.complete': {
      if (frame.jobId !== job.id) return job;
      if (isTerminal(job.status)) return job;
      return {
        ...job,
        status: 'complete',
        queuePosition: null,
        assets: frame.assets,
        finishedAt: job.finishedAt ?? new Date().toISOString(),
        // Snap the bar to full and drop the preview: the real image is here,
        // and a stale preview under a finished result reads as a bug.
        progress: { ...job.progress, fraction: 1, etaSeconds: 0, previewUrl: null },
      };
    }

    case 'job.failed': {
      if (frame.jobId !== job.id) return job;
      if (isTerminal(job.status)) return job;
      return {
        ...job,
        status: 'failed',
        queuePosition: null,
        error: frame.error,
        finishedAt: job.finishedAt ?? new Date().toISOString(),
        progress: { ...job.progress, previewUrl: null },
      };
    }

    // `backend.status` is the shell's business (see shell/useBackends.ts), and
    // anything we do not recognise is a type added after this build shipped.
    default:
      return job;
  }
}

/**
 * Merge a progress frame, refusing to go backwards.
 *
 * `fraction` is the guard rather than `step`, because video jobs report frames
 * and not steps, and `fraction` is the contract's "our best single number".
 * Equal fractions still merge — a frame can carry a new preview at the same
 * step — but return the original object when literally nothing changed.
 */
export function mergeProgress(current: JobProgress, incoming: JobProgress): JobProgress {
  if (incoming.fraction < current.fraction) return current;

  const next: JobProgress = {
    step: incoming.step ?? current.step,
    totalSteps: incoming.totalSteps ?? current.totalSteps,
    frame: incoming.frame ?? current.frame,
    totalFrames: incoming.totalFrames ?? current.totalFrames,
    fraction: incoming.fraction,
    etaSeconds: incoming.etaSeconds,
    previewUrl: incoming.previewUrl ?? current.previewUrl,
  };

  const unchanged =
    next.step === current.step &&
    next.totalSteps === current.totalSteps &&
    next.frame === current.frame &&
    next.totalFrames === current.totalFrames &&
    next.fraction === current.fraction &&
    next.etaSeconds === current.etaSeconds &&
    next.previewUrl === current.previewUrl;

  return unchanged ? current : next;
}

/**
 * Should the stage switch to the job in a `job.created` frame?
 *
 * Yes when we are showing nothing, or when what we are showing has finished:
 * another tab (or a queued-up second submit) starting a job should take over an
 * idle stage but must not shove aside a run in progress.
 */
export function adoptCreated(current: Job | null, created: Job): boolean {
  if (!current) return true;
  if (current.id === created.id) return true;
  return isTerminal(current.status);
}

/** Assets, whether they arrived on the job or in a `job.complete` frame. */
export function resultAssets(job: Job | null): Asset[] {
  return job?.assets ?? [];
}
