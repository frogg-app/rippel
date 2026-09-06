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
    phase: null,
    phaseLabel: null,
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
 *  2. Nothing *rewinds* a terminal job: a straggling `progress` or `status`
 *     frame from before the end must not resurrect it. The two frames that
 *     carry an outcome's payload — `job.complete` (the assets) and
 *     `job.failed` (the message) — are the exception, because the server
 *     announces the outcome twice and the payload arrives second. `setStatus`
 *     publishes `job.status: complete` and only *then* is `job.complete`
 *     published with the assets; `failJob` does the same with the message.
 *     Refusing them because the status is already terminal is how a finished
 *     job ends up on screen saying "Done" with an empty canvas. A payload
 *     frame is still refused when it contradicts an outcome already recorded
 *     (no completing a failed job), and returns the same object when it
 *     carries nothing new, so a reconnect's re-delivery is a no-op.
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
      // A different outcome has already been recorded; a completion cannot
      // undo it.
      if (job.status === 'failed' || job.status === 'cancelled') return job;
      // Already complete with these exact assets: a re-delivery after a
      // reconnect. Return the same object so React skips the render.
      if (job.status === 'complete' && sameAssets(job.assets, frame.assets)) return job;
      return {
        ...job,
        status: 'complete',
        queuePosition: null,
        assets: frame.assets,
        finishedAt: job.finishedAt ?? new Date().toISOString(),
        // Snap the bar to full and drop the preview and the phase: the real
        // image is here, and a stale preview — or a row still saying "Decoding
        // image" — under a finished result reads as a bug.
        progress: {
          ...job.progress,
          fraction: 1,
          etaSeconds: 0,
          previewUrl: null,
          phase: null,
          phaseLabel: null,
        },
      };
    }

    case 'job.failed': {
      if (frame.jobId !== job.id) return job;
      if (job.status === 'complete' || job.status === 'cancelled') return job;
      if (job.status === 'failed' && job.error === frame.error) return job;
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

/** Same results, in the same order — the test for a re-delivered completion. */
function sameAssets(current: Asset[], incoming: Asset[]): boolean {
  return (
    current.length === incoming.length &&
    current.every((asset, index) => asset.id === incoming[index]?.id)
  );
}

/**
 * Merge a progress frame, refusing to go backwards.
 *
 * `fraction` is the guard rather than `step`, because video jobs report frames
 * and not steps, and `fraction` is the contract's "our best single number".
 * Equal fractions still merge — a frame can carry a new preview at the same
 * step — but return the original object when literally nothing changed.
 *
 * A frame that announces a *new phase* is exempt from the backwards guard.
 * `fraction` is only defined within sampling, so the frame that says "decoding
 * now" is entitled to reset it; dropping that frame for going backwards would
 * leave the screen claiming to still be sampling for the length of a CPU VAE
 * decode, which is the exact failure the phase was added to fix.
 */
export function mergeProgress(current: JobProgress, incoming: JobProgress): JobProgress {
  const phaseChanged = incoming.phase != null && incoming.phase !== current.phase;
  if (!phaseChanged && incoming.fraction < current.fraction) return current;

  // A label belongs to its phase: when the phase moves on, a frame that carries
  // no label of its own has no label, rather than inheriting the last one and
  // saying "Loading SDXL" through the decode.
  const phase = incoming.phase ?? current.phase ?? null;
  const phaseLabel = phaseChanged
    ? incoming.phaseLabel ?? null
    : incoming.phaseLabel ?? current.phaseLabel ?? null;

  const next: JobProgress = {
    step: incoming.step ?? current.step,
    totalSteps: incoming.totalSteps ?? current.totalSteps,
    frame: incoming.frame ?? current.frame,
    totalFrames: incoming.totalFrames ?? current.totalFrames,
    fraction: incoming.fraction,
    etaSeconds: incoming.etaSeconds,
    previewUrl: incoming.previewUrl ?? current.previewUrl,
    phase,
    phaseLabel,
  };

  const unchanged =
    next.step === current.step &&
    next.totalSteps === current.totalSteps &&
    next.frame === current.frame &&
    next.totalFrames === current.totalFrames &&
    next.fraction === current.fraction &&
    next.etaSeconds === current.etaSeconds &&
    next.previewUrl === current.previewUrl &&
    next.phase === (current.phase ?? null) &&
    next.phaseLabel === (current.phaseLabel ?? null);

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
