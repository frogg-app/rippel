/**
 * The progress reducer, against the frame sequences a real socket produces:
 * in order, out of order, duplicated, after the job has finished, and carrying
 * a type this build has never heard of.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Job, JobEvent, JobProgress } from '@comfy/shared';
import { adoptCreated, applyJobEvent, emptyProgress, isTerminal } from './jobProgress';

const JOB_ID = 'job-1';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    userId: 'user-1',
    kind: 'txt2img',
    status: 'queued',
    queuePosition: 2,
    params: {
      kind: 'txt2img',
      prompt: 'a lone figure',
      modelId: 'model-1',
      quality: 'balanced',
      aspect: '1:1',
      batchSize: 1,
    },
    backendId: null,
    progress: emptyProgress(),
    error: null,
    createdAt: '2026-09-06T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    assets: [],
    ...overrides,
  };
}

function progress(step: number, total: number, extra: Partial<JobProgress> = {}): JobProgress {
  return {
    ...emptyProgress(),
    step,
    totalSteps: total,
    fraction: step / total,
    etaSeconds: total - step,
    ...extra,
  };
}

const asset: Asset = {
  id: 'asset-1',
  jobId: JOB_ID,
  kind: 'image',
  url: '/api/assets/asset-1',
  thumbUrl: '/api/assets/asset-1/thumb',
  width: 1024,
  height: 1024,
  duration: null,
  starred: false,
  createdAt: '2026-09-06T10:00:30.000Z',
};

describe('applyJobEvent', () => {
  it('walks a normal lifecycle', () => {
    let current: Job | null = job();

    current = applyJobEvent(current, {
      type: 'job.status',
      jobId: JOB_ID,
      status: 'dispatched',
      queuePosition: null,
    });
    expect(current?.status).toBe('dispatched');

    current = applyJobEvent(current, {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: progress(5, 28),
    });
    expect(current?.status).toBe('running');
    expect(current?.progress.step).toBe(5);

    current = applyJobEvent(current, { type: 'job.complete', jobId: JOB_ID, assets: [asset] });
    expect(current?.status).toBe('complete');
    expect(current?.assets).toEqual([asset]);
    expect(current?.progress.fraction).toBe(1);
  });

  it('infers running from a progress frame that overtakes its status frame', () => {
    const next = applyJobEvent(job({ status: 'queued', queuePosition: 0 }), {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: progress(3, 28),
    });
    expect(next?.status).toBe('running');
    expect(next?.queuePosition).toBeNull();
  });

  it('ignores a progress frame that arrives out of order', () => {
    const at20 = applyJobEvent(job({ status: 'running' }), {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: progress(20, 28),
    });
    const late = applyJobEvent(at20, {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: progress(12, 28),
    });
    expect(late).toBe(at20); // same object: nothing was applied
    expect(late?.progress.step).toBe(20);
  });

  it('keeps the last preview when a later frame carries none', () => {
    const withPreview = applyJobEvent(job({ status: 'running' }), {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: progress(10, 28, { previewUrl: 'data:image/png;base64,AAA' }),
    });
    const without = applyJobEvent(withPreview, {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: progress(11, 28),
    });
    expect(without?.progress.previewUrl).toBe('data:image/png;base64,AAA');
  });

  it('never moves the status backwards', () => {
    const running = job({ status: 'running' });
    const back = applyJobEvent(running, {
      type: 'job.status',
      jobId: JOB_ID,
      status: 'queued',
      queuePosition: 3,
    });
    expect(back).toBe(running);
  });

  it('lets nothing move a finished job', () => {
    const done = applyJobEvent(job({ status: 'running' }), {
      type: 'job.complete',
      jobId: JOB_ID,
      assets: [asset],
    });

    const events: JobEvent[] = [
      { type: 'job.progress', jobId: JOB_ID, progress: progress(27, 28) },
      { type: 'job.status', jobId: JOB_ID, status: 'running', queuePosition: null },
      { type: 'job.failed', jobId: JOB_ID, error: 'too late' },
    ];
    for (const event of events) {
      expect(applyJobEvent(done, event)).toBe(done);
    }
    expect(done?.assets).toEqual([asset]);
  });

  it('applies job.complete after the status frame that already said complete', () => {
    // The orchestrator's own order (`setStatus(id, 'complete')` publishes
    // `job.status`, and only then does it publish `job.complete` with the
    // assets). A reducer that refuses every frame once the status is terminal
    // throws the results away, and the image only appears on reload.
    const running = job({ status: 'running', progress: progress(28, 28) });
    const said = applyJobEvent(running, {
      type: 'job.status',
      jobId: JOB_ID,
      status: 'complete',
      queuePosition: null,
    });
    expect(said?.status).toBe('complete');
    expect(said?.assets).toEqual([]);

    const done = applyJobEvent(said, { type: 'job.complete', jobId: JOB_ID, assets: [asset] });
    expect(done?.assets).toEqual([asset]);
    expect(done).not.toBe(said); // a new object, so React re-renders
    expect(done?.progress.fraction).toBe(1);
    expect(done?.progress.previewUrl).toBeNull();
  });

  it('is idempotent when job.complete is re-delivered after a reconnect', () => {
    const done = applyJobEvent(job({ status: 'running' }), {
      type: 'job.complete',
      jobId: JOB_ID,
      assets: [asset],
    });
    expect(applyJobEvent(done, { type: 'job.complete', jobId: JOB_ID, assets: [asset] })).toBe(done);
  });

  it('applies job.failed after the status frame that already said failed', () => {
    // `failJob` does the same two-step: setStatus('failed') then `job.failed`
    // carrying the message. Without this the stage says "Failed" with no reason.
    const said = applyJobEvent(job({ status: 'running' }), {
      type: 'job.status',
      jobId: JOB_ID,
      status: 'failed',
      queuePosition: null,
    });
    const failed = applyJobEvent(said, {
      type: 'job.failed',
      jobId: JOB_ID,
      error: 'VAEDecode failed: CUDA error: invalid kernel file',
    });
    expect(failed?.error).toBe('VAEDecode failed: CUDA error: invalid kernel file');
    expect(failed).not.toBe(said);
  });

  it('does not let a completion overwrite a failure, or the reverse', () => {
    const failed = applyJobEvent(job({ status: 'running' }), {
      type: 'job.failed',
      jobId: JOB_ID,
      error: 'boom',
    });
    expect(applyJobEvent(failed, { type: 'job.complete', jobId: JOB_ID, assets: [asset] })).toBe(failed);

    const done = applyJobEvent(job({ status: 'running' }), {
      type: 'job.complete',
      jobId: JOB_ID,
      assets: [asset],
    });
    expect(applyJobEvent(done, { type: 'job.failed', jobId: JOB_ID, error: 'too late' })).toBe(done);
  });

  it('ignores frames for a different job', () => {
    const mine = job({ status: 'running' });
    const events: JobEvent[] = [
      { type: 'job.progress', jobId: 'job-2', progress: progress(9, 28) },
      { type: 'job.status', jobId: 'job-2', status: 'complete', queuePosition: null },
      { type: 'job.complete', jobId: 'job-2', assets: [asset] },
      { type: 'job.failed', jobId: 'job-2', error: 'not mine' },
    ];
    for (const event of events) {
      expect(applyJobEvent(mine, event)).toBe(mine);
    }
  });

  it('tolerates an unknown event type', () => {
    const current = job({ status: 'running' });
    expect(applyJobEvent(current, { type: 'job.thumbnailed', jobId: JOB_ID } as never)).toBe(current);
    expect(applyJobEvent(current, { type: 'quota.exceeded' } as never)).toBe(current);
  });

  it('ignores backend.status, which belongs to the shell', () => {
    const current = job({ status: 'running' });
    const event = { type: 'backend.status', backend: { id: 'b1' } } as unknown as JobEvent;
    expect(applyJobEvent(current, event)).toBe(current);
  });

  it('records a failure with the message the server gave', () => {
    const failed = applyJobEvent(job({ status: 'running' }), {
      type: 'job.failed',
      jobId: JOB_ID,
      error: 'no_backend: nothing online has that checkpoint',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/no_backend/);
    expect(isTerminal(failed!.status)).toBe(true);
  });

  it('applies a re-delivered job.created for the job on screen', () => {
    const fresher = job({ status: 'running', progress: progress(7, 28) });
    const next = applyJobEvent(job(), { type: 'job.created', job: fresher });
    expect(next).toBe(fresher);
  });

  it('does nothing at all when no job is on screen', () => {
    expect(applyJobEvent(null, { type: 'job.progress', jobId: JOB_ID, progress: progress(1, 28) })).toBeNull();
  });

  it('survives a shuffled burst, landing on the furthest state', () => {
    // What a reconnect delivers: everything at once, in no useful order.
    const events: JobEvent[] = [
      { type: 'job.progress', jobId: JOB_ID, progress: progress(18, 28) },
      { type: 'job.status', jobId: JOB_ID, status: 'running', queuePosition: null },
      { type: 'job.progress', jobId: JOB_ID, progress: progress(4, 28) },
      { type: 'job.progress', jobId: JOB_ID, progress: progress(24, 28, { previewUrl: 'data:x' }) },
      { type: 'job.progress', jobId: JOB_ID, progress: progress(11, 28) },
    ];
    let current: Job | null = job();
    for (const event of events) current = applyJobEvent(current, event);

    expect(current?.status).toBe('running');
    expect(current?.progress.step).toBe(24);
    expect(current?.progress.previewUrl).toBe('data:x');
  });
});

describe('phase', () => {
  it('carries phase and label through a merge', () => {
    const next = applyJobEvent(job({ status: 'dispatched' }), {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: { ...emptyProgress(), phase: 'preparing', phaseLabel: 'Loading SDXL' },
    });
    expect(next?.progress.phase).toBe('preparing');
    expect(next?.progress.phaseLabel).toBe('Loading SDXL');
  });

  it('lets a new phase through even when its fraction goes backwards', () => {
    // `fraction` is only defined within sampling, so the frame that says
    // "decoding now" is entitled to reset it. Dropping it as an out-of-order
    // frame would leave the row claiming to still be sampling for the length
    // of a CPU VAE decode.
    const sampling = applyJobEvent(job({ status: 'running' }), {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: { ...progress(28, 28), phase: 'sampling', phaseLabel: 'Generating' },
    });
    const decoding = applyJobEvent(sampling, {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: { ...emptyProgress(), fraction: 0, phase: 'decoding', phaseLabel: 'Decoding image' },
    });
    expect(decoding?.progress.phase).toBe('decoding');
    expect(decoding?.progress.phaseLabel).toBe('Decoding image');
  });

  it('does not carry a label across a phase change', () => {
    const preparing = applyJobEvent(job({ status: 'running' }), {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: { ...emptyProgress(), phase: 'preparing', phaseLabel: 'Loading SDXL' },
    });
    const sampling = applyJobEvent(preparing, {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: { ...progress(1, 28), phase: 'sampling' },
    });
    expect(sampling?.progress.phaseLabel).toBeNull();
  });

  it('keeps the phase when a later frame omits it', () => {
    const sampling = applyJobEvent(job({ status: 'running' }), {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: { ...progress(4, 28), phase: 'sampling', phaseLabel: 'Generating' },
    });
    const next = applyJobEvent(sampling, {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: progress(5, 28),
    });
    expect(next?.progress.phase).toBe('sampling');
    expect(next?.progress.phaseLabel).toBe('Generating');
  });

  it('is inert on an API that never sends a phase', () => {
    const next = applyJobEvent(job({ status: 'running' }), {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: progress(9, 28),
    });
    expect(next?.progress.phase ?? null).toBeNull();
    expect(next?.progress.step).toBe(9);
  });

  it('drops the phase when the job completes', () => {
    const sampling = applyJobEvent(job({ status: 'running' }), {
      type: 'job.progress',
      jobId: JOB_ID,
      progress: { ...progress(28, 28), phase: 'sampling', phaseLabel: 'Generating' },
    });
    const done = applyJobEvent(sampling, { type: 'job.complete', jobId: JOB_ID, assets: [asset] });
    expect(done?.progress.phase).toBeNull();
    expect(done?.progress.phaseLabel).toBeNull();
  });
});

describe('adoptCreated', () => {
  it('takes over an empty stage', () => {
    expect(adoptCreated(null, job({ id: 'job-9' }))).toBe(true);
  });

  it('takes over a finished job', () => {
    expect(adoptCreated(job({ status: 'complete' }), job({ id: 'job-9' }))).toBe(true);
  });

  it('does not shove aside a run in progress', () => {
    expect(adoptCreated(job({ status: 'running' }), job({ id: 'job-9' }))).toBe(false);
  });
});
