/**
 * The Create screen, driven through the DOM.
 *
 * The pure rules are covered in `create/form.test.ts` and
 * `create/jobProgress.test.ts`; what is tested here is the wiring those cannot
 * see — that the dice and the lock reach `POST /jobs`, that a model with no
 * template cannot be chosen, and that a socket frame moves the bar.
 *
 * `src/lib/api-jobs.ts` is mocked wholesale rather than `fetch`: it is the
 * single seam by design, so mocking it is the same shape as flipping
 * `MOCK.jobs` to false.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationParams, Job, JobEvent, JobProgress, Model } from '@comfy/shared';

const capabilities = {
  byFamily: {
    sdxl: ['txt2img'],
    // The box this runs on: two of the three checkpoints are video models,
    // which is what made the picker read as broken.
    hunyuanvideo: ['txt2vid'],
  },
  live: true,
};

const checkpoints: Model[] = [
  {
    id: 'model-sdxl',
    type: 'checkpoint',
    filename: 'sd_xl_base_1.0.safetensors',
    displayName: 'SDXL Base 1.0',
    baseModel: 'sdxl',
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: ['backend-1'],
  },
  {
    id: 'model-sdxl-2',
    type: 'checkpoint',
    filename: 'juggernaut_xl.safetensors',
    displayName: 'Juggernaut XL',
    baseModel: 'sdxl',
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: ['backend-1'],
  },
  {
    id: 'model-hunyuan',
    type: 'checkpoint',
    filename: 'hunyuan_video.safetensors',
    displayName: 'Hunyuan Video 720p',
    baseModel: 'hunyuan-video',
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: ['backend-1'],
  },
];

const created: GenerationParams[] = [];
let emit: ((event: JobEvent) => void) | null = null;

function queuedJob(params: GenerationParams): Job {
  return {
    id: 'job-1',
    userId: 'user-1',
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
    createdAt: '2026-09-06T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    assets: [],
  };
}

vi.mock('../lib/api-jobs', async () => {
  const actual = await vi.importActual<typeof import('../lib/api-jobs')>('../lib/api-jobs');
  return {
    ...actual,
    MOCK: { jobs: true },
    modelsApi: {
      list: vi.fn(async ({ type }: { type?: string } = {}) => ({
        models: type === 'checkpoint' ? checkpoints : [],
        families: ['sdxl', 'hunyuan-video'],
      })),
    },
    workflowsApi: { capabilities: vi.fn(async () => capabilities) },
    jobsApi: {
      create: vi.fn(async (params: GenerationParams) => {
        created.push(params);
        return { job: queuedJob(params) };
      }),
      get: vi.fn(async () => {
        throw new Error('no such job');
      }),
      list: vi.fn(async () => ({ jobs: [] })),
      cancel: vi.fn(async () => ({ job: queuedJob(created[0]!) })),
    },
    subscribeToEvents: (handlers: { onEvent: (event: JobEvent) => void; onConnectionChange?: (s: string) => void }) => {
      emit = handlers.onEvent;
      handlers.onConnectionChange?.('open');
      return () => {
        emit = null;
      };
    },
  };
});

const { CreatePage } = await import('./CreatePage');
const { ModeToggle } = await import('../shell/ModeToggle');
const { resetCreateMode } = await import('../create/mode');

beforeEach(() => {
  created.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  resetCreateMode();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.getByRole('button', { name: /advanced/i });
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
}

describe('CreatePage', () => {
  it('will not submit without a prompt, and says why', async () => {
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });

    const generate = screen.getByRole('button', { name: /generate/i });
    expect(generate).toBeDisabled();
    expect(screen.getByText('Write a prompt first.')).toBeInTheDocument();
  });

  it('will not let a model with no template be chosen, and says why', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    const blocked = await screen.findByRole('radio', { name: /Hunyuan/i });

    // `aria-disabled`, not `disabled`: a disabled button takes no click and
    // shows no tooltip, so the explanation is unreachable by the person who
    // needs it. Pressing it must not select it, and must answer.
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    await user.click(blocked);
    expect(blocked).toHaveAttribute('aria-checked', 'false');
    expect(await screen.findByText(/is a video model/i)).toBeInTheDocument();

    // ...and the runnable one is preselected, so the screen opens usable.
    // Preselection waits on the capabilities fetch, so this waits too — read
    // eagerly it passes or fails depending on promise scheduling.
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /SDXL Base/i })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
  });

  it('POSTs params that match the form', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });

    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'a rain-slick street');
    await user.click(screen.getByRole('radio', { name: 'High' }));
    await user.click(screen.getByRole('radio', { name: '16:9' }));
    await user.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      kind: 'txt2img',
      prompt: 'a rain-slick street',
      modelId: 'model-sdxl',
      quality: 'high',
      aspect: '16:9',
      batchSize: 1,
    });
    expect(typeof created[0]!.advanced?.seed).toBe('number');
  });

  it('rolls the seed on each run unless it is locked', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');
    await openAdvanced(user);

    const seedOf = () => screen.getByTestId('seed-value').textContent;

    // The dice changes the number on screen without submitting anything.
    const before = seedOf();
    await user.click(screen.getByRole('button', { name: /randomise the seed/i }));
    expect(seedOf()).not.toBe(before);
    expect(created).toHaveLength(0);

    // Lock it, and the number that was on screen is the number that is sent.
    await user.click(screen.getByRole('button', { name: /lock the seed/i }));
    const locked = seedOf();
    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));

    expect(created[0]!.advanced?.seedLocked).toBe(true);
    expect(formatted(created[0]!.advanced!.seed!)).toBe(locked);
    expect(seedOf()).toBe(locked); // still on screen, unchanged
  });

  it('applies socket frames to the stage, including out-of-order ones', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');
    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));

    const frame = (step: number) => ({
      type: 'job.progress' as const,
      jobId: 'job-1',
      progress: {
        step,
        totalSteps: 28,
        frame: null,
        totalFrames: null,
        fraction: step / 28,
        etaSeconds: 28 - step,
        previewUrl: null,
      },
    });

    // A socket frame is an outside-of-React update; act() makes the assertion
    // that follows see the render it caused.
    act(() => emit?.(frame(18)));
    await screen.findByText('step 18 / 28');

    // A late frame must not rewind the counter, and an unknown type must not
    // throw the render away.
    act(() => {
      emit?.(frame(9));
      emit?.({ type: 'job.thumbnailed' } as unknown as JobEvent);
    });
    expect(screen.getByText('step 18 / 28')).toBeInTheDocument();

    const bar = screen.getByRole('progressbar', { name: /generation progress/i });
    expect(bar).toHaveAttribute('aria-valuenow', '64');

    act(() =>
      emit?.({
        type: 'job.complete',
        jobId: 'job-1',
        assets: [
          {
            id: 'asset-1',
            jobId: 'job-1',
            kind: 'image',
            url: '/api/assets/asset-1',
            thumbUrl: '/api/assets/asset-1/thumb',
            width: 1024,
            height: 1024,
            duration: null,
            starred: false,
            createdAt: '2026-09-06T10:01:00.000Z',
          },
        ],
      }),
    );

    await screen.findByText('Done');
    const tray = screen.getByRole('link', { name: /save/i });
    expect(tray).toHaveAttribute('href', '/api/assets/asset-1');
    // Animate is deliberately inert until video lands, and says so.
    expect(screen.getByRole('button', { name: /animate/i })).toBeDisabled();
  });

  it('shows the finished image when job.status complete arrives before job.complete', async () => {
    // Exactly the order the orchestrator publishes in: `setStatus('complete')`
    // fires `job.status`, and only then does `job.complete` carry the assets.
    // The bug this pins: the stage said "Done" but stayed empty until reload.
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');
    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));

    act(() => {
      emit?.({ type: 'job.status', jobId: 'job-1', status: 'complete', queuePosition: null });
      emit?.({
        type: 'job.complete',
        jobId: 'job-1',
        assets: [
          {
            id: 'asset-7',
            jobId: 'job-1',
            kind: 'image',
            url: '/api/assets/asset-7',
            thumbUrl: '/api/assets/asset-7/thumb',
            width: 1024,
            height: 1024,
            duration: null,
            starred: false,
            createdAt: '2026-09-06T10:01:00.000Z',
          },
        ],
      });
    });

    await screen.findByText('Done');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /save/i })).toHaveAttribute(
        'href',
        '/api/assets/asset-7',
      ),
    );
  });

  it('shows the backend’s own message when a job fails', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');
    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));

    act(() => {
      emit?.({ type: 'job.status', jobId: 'job-1', status: 'failed', queuePosition: null });
      emit?.({
        type: 'job.failed',
        jobId: 'job-1',
        error: 'VAEDecode failed: CUDA error: invalid kernel file',
      });
    });

    await screen.findByText('VAEDecode failed: CUDA error: invalid kernel file');
  });

  it('remembers the Advanced drawer between mounts', async () => {
    const user = userEvent.setup();
    const first = render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await openAdvanced(user);
    first.unmount();

    render(<CreatePage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /advanced/i })).toHaveAttribute(
        'aria-expanded',
        'true',
      ),
    );
  });

  it('refills the form from a finished job when you remix it', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });

    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'a cathedral of glass');
    await user.click(screen.getByRole('radio', { name: 'Fast' }));
    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));

    act(() => emit?.({ type: 'job.complete', jobId: 'job-1', assets: [] }));
    await screen.findByText('Done');

    // Change the form out from under it, then remix back.
    await user.clear(screen.getByRole('textbox', { name: /prompt/i }));
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'something else');
    await user.click(screen.getByRole('radio', { name: 'High' }));

    await user.click(screen.getByRole('button', { name: /remix/i }));

    expect(screen.getByRole('textbox', { name: /prompt/i })).toHaveValue('a cathedral of glass');
    expect(screen.getByRole('radio', { name: 'Fast' })).toHaveAttribute('aria-checked', 'true');
    // Remix pins the seed and opens the drawer so that is visible.
    const advanced = screen.getByRole('button', { name: /advanced/i });
    expect(advanced).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(screen.getByTestId('seed-value').closest('div')!).getByRole('button', {
        name: /seed locked/i,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});

/** Get a job running, so the stage is showing the progress row. */
async function startJob(user: ReturnType<typeof userEvent.setup>) {
  render(<CreatePage />);
  await screen.findByRole('radio', { name: /SDXL Base/i });
  await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');
  await user.click(screen.getByRole('button', { name: /^generate$/i }));
  await waitFor(() => expect(created).toHaveLength(1));
}

function progressFrame(progress: Partial<JobProgress>): JobEvent {
  return {
    type: 'job.progress',
    jobId: 'job-1',
    progress: {
      step: null,
      totalSteps: null,
      frame: null,
      totalFrames: null,
      fraction: 0,
      etaSeconds: null,
      previewUrl: null,
      ...progress,
    },
  };
}

describe('progress detail', () => {
  it('shows an indeterminate bar and the phase label outside sampling', async () => {
    // The VAE decode is the case that matters: it is slow, it has no fraction,
    // and a bar left at 100% through it reads as a hang.
    const user = userEvent.setup();
    await startJob(user);

    act(() =>
      emit?.(
        progressFrame({
          step: 28,
          totalSteps: 28,
          fraction: 1,
          phase: 'decoding',
          phaseLabel: 'Decoding image',
        }),
      ),
    );

    const label = await screen.findAllByText('Decoding image');
    expect(label.length).toBeGreaterThan(0);

    const bar = screen.getByRole('progressbar', { name: /generation progress/i });
    expect(bar).not.toHaveAttribute('aria-valuenow'); // indeterminate, not 100%
    expect(bar).toHaveAttribute('aria-valuetext', 'Decoding image');
    // No number is meaningful here, so none is shown.
    expect(screen.queryByText('step 28 / 28')).not.toBeInTheDocument();
  });

  it('shows the bar, the step count and the ETA while sampling', async () => {
    const user = userEvent.setup();
    await startJob(user);

    act(() =>
      emit?.(
        progressFrame({
          step: 14,
          totalSteps: 28,
          fraction: 0.5,
          etaSeconds: 21,
          phase: 'sampling',
          phaseLabel: 'Generating',
          previewUrl: 'data:image/png;base64,AAA',
        }),
      ),
    );

    await screen.findByText('step 14 / 28');
    expect(screen.getByText('~21s')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: /generation progress/i }),
    ).toHaveAttribute('aria-valuenow', '50');

    // The live preview frame is on the canvas while sampling.
    expect(screen.getByText('LIVE PREVIEW')).toBeInTheDocument();
  });

  it('falls back to the old behaviour when the API sends no phase', async () => {
    const user = userEvent.setup();
    await startJob(user);

    act(() => emit?.(progressFrame({ step: 7, totalSteps: 28, fraction: 0.25, etaSeconds: 30 })));

    await screen.findByText('step 7 / 28');
    expect(
      screen.getByRole('progressbar', { name: /generation progress/i }),
    ).toHaveAttribute('aria-valuenow', '25');
  });

  it('shows where the job is in the queue', async () => {
    const user = userEvent.setup();
    await startJob(user);

    act(() =>
      emit?.({ type: 'job.status', jobId: 'job-1', status: 'queued', queuePosition: 2 }),
    );
    await screen.findByText('position 3');

    act(() =>
      emit?.({ type: 'job.status', jobId: 'job-1', status: 'queued', queuePosition: 0 }),
    );
    await screen.findByText('next up');
  });
});

describe('mode toggle', () => {
  it('drives the capability the form submits', async () => {
    // The bug: the toggle was local state, so switching to Video changed the
    // highlight and nothing else — a video job went out as txt2img.
    const user = userEvent.setup();
    render(
      <>
        <ModeToggle />
        <CreatePage />
      </>,
    );
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'a wave breaking');

    await user.click(screen.getByRole('radio', { name: 'Video' }));

    // The video checkpoint is now the selectable one, and the image ones are not.
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Hunyuan/i })).toHaveAttribute(
        'aria-disabled',
        'false',
      ),
    );
    expect(screen.getByRole('radio', { name: /SDXL Base/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await user.click(screen.getByRole('radio', { name: /Hunyuan/i }));
    await user.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.kind).toBe('txt2vid');
    expect(created[0]!.modelId).toBe('model-hunyuan');
  });

  it('offers the switch when nothing in this mode can run', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ModeToggle />
        <CreatePage />
      </>,
    );
    await screen.findByRole('radio', { name: /SDXL Base/i });

    // In video mode the only runnable checkpoint is the Hunyuan one; block it
    // by asking about the image models and check the picker points the way
    // back rather than leaving the user stuck.
    await user.click(screen.getByRole('radio', { name: 'Video' }));
    await user.click(await screen.findByRole('radio', { name: /SDXL Base/i }));

    const back = await screen.findByRole('button', { name: /switch to image mode/i });
    await user.click(back);

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Image' })).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.getByRole('radio', { name: /SDXL Base/i })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });
});

describe('model picker', () => {
  it('lets you change between models that do qualify', async () => {
    // The user reported "I can't change models". Two SDXL checkpoints both
    // qualify for txt2img, so switching between them must work.
    const user = userEvent.setup();
    render(<CreatePage />);
    const first = await screen.findByRole('radio', { name: /SDXL Base/i });
    await waitFor(() => expect(first).toHaveAttribute('aria-checked', 'true'));

    const second = screen.getByRole('radio', { name: /Juggernaut/i });
    await user.click(second);

    expect(second).toHaveAttribute('aria-checked', 'true');
    expect(first).toHaveAttribute('aria-checked', 'false');

    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');
    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.modelId).toBe('model-sdxl-2');
  });
});

function formatted(seed: number): string {
  return String(seed).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
