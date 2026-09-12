/**
 * A failed job, as the person who typed the prompt sees it.
 *
 * The bug: every failure rendered as `job.error`, which for the most common one
 * on a card too small for the clip is the allocator's paragraph — addressed to
 * somebody debugging PyTorch, not to somebody who waited three minutes for a
 * video. These tests hold the headline, the advice, and the fact that the raw
 * text is still reachable rather than thrown away.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Job, JobFailure } from '@comfy/shared';
import { JobStage } from './JobStage';

const OOM_TEXT =
  'KSampler failed: HIP out of memory. Tried to allocate 2.44 GiB. GPU 0 has a total capacity of 15.98 GiB of which 1.02 GiB is free.';

function failedJob(failure: JobFailure | null, error = OOM_TEXT): Job {
  return {
    id: 'job-1',
    userId: 'user-1',
    kind: 'img2vid',
    status: 'failed',
    queuePosition: null,
    params: {
      kind: 'img2vid',
      prompt: 'a paper boat',
      modelId: 'model-1',
      quality: 'balanced',
      aspect: '16:9',
      batchSize: 1,
    },
    backendId: 'backend-1',
    progress: {
      step: null, totalSteps: null, frame: null, totalFrames: null,
      fraction: 0, etaSeconds: null, previewUrl: null,
    },
    error,
    failure,
    createdAt: '2026-09-12T00:00:00Z',
    startedAt: '2026-09-12T00:00:01Z',
    finishedAt: '2026-09-12T00:03:00Z',
    assets: [],
  };
}

const OOM: JobFailure = {
  kind: 'out-of-memory',
  summary: 'The machine ran out of graphics memory part-way through this job.',
  steps: ['Make the clip shorter, or drop the resolution one step.'],
  detail: OOM_TEXT,
};

function paint(job: Job) {
  render(
    <JobStage
      job={job}
      submitting={false}
      submitError={null}
      disconnected={false}
      place={null}
      onCancel={() => {}}
      onRemix={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe('a failed job leads with what it means', () => {
  it('headlines the diagnosis rather than six generic words', () => {
    paint(failedJob(OOM));
    expect(screen.getByText('Ran out of memory')).toBeInTheDocument();
    expect(screen.queryByText('Generation failed')).not.toBeInTheDocument();
  });

  it('says it in a sentence with no allocator arithmetic in it', () => {
    paint(failedJob(OOM));
    const summary = screen.getByText(/ran out of graphics memory/i);
    expect(summary).toBeInTheDocument();
    expect(summary.textContent).not.toMatch(/GiB/);
  });

  it('offers the move that would actually change the outcome', () => {
    paint(failedJob(OOM));
    expect(screen.getByText(/Make the clip shorter/)).toBeInTheDocument();
  });

  it('keeps the machine’s own words, behind a disclosure', () => {
    // Not dropped: it is the only thing that says precisely what went wrong,
    // and it is what gets pasted into a bug report.
    paint(failedJob(OOM));
    expect(screen.getByText('What the machine said')).toBeInTheDocument();
    expect(screen.getByText(OOM_TEXT)).toBeInTheDocument();
  });

  it('falls back to the raw text for a job stored before classification', () => {
    paint(failedJob(null));
    expect(screen.getByText('Generation failed')).toBeInTheDocument();
    expect(screen.getByText(OOM_TEXT)).toBeInTheDocument();
  });

  it('gives a missing file its own headline, not the memory one', () => {
    paint(
      failedJob({
        kind: 'missing-model',
        summary: 'A file this workflow needs is not on that machine, or cannot be read.',
        steps: ['Open the model on the Models screen — it names the exact file and folder.'],
        detail: "unet_name: 'wan2.2_ti2v_5B_fp16.safetensors' not in []",
      }),
    );
    expect(screen.getByText('A file is missing')).toBeInTheDocument();
  });
});

describe('the fit warning', () => {
  const running: Job = { ...failedJob(null, ''), status: 'running', error: null, failure: null };

  function paintWith(fit: Parameters<typeof JobStage>[0]['fit']) {
    render(
      <JobStage
        job={running}
        submitting={false}
        submitError={null}
        fit={fit}
        disconnected={false}
        place={null}
        onCancel={() => {}}
        onRemix={() => {}}
        onDismiss={() => {}}
      />,
    );
  }

  it('warns when the machine has already failed a job this size', () => {
    paintWith({
      verdict: 'too-big',
      note: 'A job this size has already run out of memory on this machine.',
      observations: 9,
    });
    expect(screen.getByText('This may not fit.')).toBeInTheDocument();
    expect(screen.getByText(/already run out of memory/)).toBeInTheDocument();
  });

  it('points at the setting that would make it finish', () => {
    paintWith({ verdict: 'unproven', note: 'This is larger than anything this machine has finished so far.', observations: 3 });
    expect(screen.getByText(/Memory setting/)).toBeInTheDocument();
  });

  it('says nothing at all when there is no verdict worth reading', () => {
    // A banner on every job trains people to ignore the one that matters.
    paintWith(null);
    expect(screen.queryByText(/may not fit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bigger than usual/i)).not.toBeInTheDocument();
  });
});
