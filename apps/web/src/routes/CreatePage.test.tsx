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
    // A family the server holds a video template for, whose backend is not set
    // up to run it — the "needs setup" case, which must stay visible.
    ltxv: ['txt2vid'],
  },
  live: true,
};

/** What the readiness endpoint says when it cannot be reached. */
const UNKNOWN = {
  state: 'unknown' as const,
  templateLabel: null,
  isFallback: false,
  summary: null,
  steps: [] as string[],
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
  {
    id: 'model-ltx',
    type: 'checkpoint',
    filename: 'ltx-video-2b.safetensors',
    displayName: 'LTX Video 2B',
    baseModel: 'ltxv',
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: ['backend-1'],
  },
  {
    id: 'model-mystery',
    type: 'checkpoint',
    filename: 'mystery_mix.safetensors',
    displayName: 'Mystery Mix',
    baseModel: 'mystery',
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

/**
 * Installed LoRAs, in the three states the picker has to tell apart: one
 * trained for the SDXL checkpoints, one whose family nothing recorded (the
 * normal case for a locally discovered file), and one for another family
 * entirely, which must not be offered.
 */
const loras: Model[] = [
  {
    id: 'lora-film',
    type: 'lora',
    filename: 'film_grain_xl.safetensors',
    displayName: 'Film Grain XL',
    baseModel: 'sdxl',
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: ['backend-1'],
  },
  {
    id: 'lora-unknown',
    type: 'lora',
    filename: 'pytorch_lora_weights.safetensors',
    displayName: 'Pytorch LoRA Weights',
    baseModel: null,
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: ['backend-1'],
  },
  {
    id: 'lora-sd15',
    type: 'lora',
    filename: 'hyper_sd15_1step.safetensors',
    displayName: 'Hyper SD15 1step LoRA',
    baseModel: 'sd15',
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: ['backend-1'],
  },
];

vi.mock('../lib/api-jobs', async () => {
  const actual = await vi.importActual<typeof import('../lib/api-jobs')>('../lib/api-jobs');
  return {
    ...actual,
    MOCK: { jobs: true },
    modelsApi: {
      list: vi.fn(async ({ type }: { type?: string } = {}) => ({
        models: type === 'checkpoint' ? checkpoints : type === 'lora' ? loras : [],
        families: ['sdxl', 'hunyuan-video'],
      })),
    },
    workflowsApi: { capabilities: vi.fn(async () => capabilities) },
    // The GPU box is usually unreachable, and an unreachable backend must not
    // make anybody's models disappear: `unknown` is the default here for the
    // same reason it is the default in production.
    readinessApi: { get: vi.fn(async () => UNKNOWN) },
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
const { resetReadinessCache } = await import('../create/useReadiness');

beforeEach(() => {
  created.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  resetCreateMode();
  resetReadinessCache();
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

  it("lists only this mode's models, and a template-less one explains itself", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });

    // A video checkpoint under Image is not a blocked tile any more; it is
    // not there at all. The toggle is what changes the list.
    expect(screen.queryByRole('radio', { name: /Hunyuan/i })).not.toBeInTheDocument();

    // A model whose family has no workflow at all is not there either — that
    // is the ask — but the count under the grid says so rather than letting
    // the list quietly misrepresent what is installed.
    expect(screen.queryByRole('radio', { name: /Mystery Mix/i })).not.toBeInTheDocument();
    expect(screen.getByText(/1 model hidden/i)).toBeInTheDocument();

    // ...and it can still be brought back, blocked, to answer for itself.
    await user.click(screen.getByRole('button', { name: /show anyway/i }));
    const blocked = screen.getByRole('radio', { name: /Mystery Mix/i });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    await user.click(blocked);
    expect(blocked).toHaveAttribute('aria-checked', 'false');
    expect(await screen.findByText(/no workflow template/i)).toBeInTheDocument();

    // ...and the runnable one is preselected, so the screen opens usable.
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
    await user.click(screen.getByRole('button', { name: /roll a new starting number/i }));
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
    // Without the /queue endpoint all we have is `Job.queuePosition`, which
    // counts only *this user's* jobs ahead. The wording says so rather than
    // implying a place in the global line — the stage takes that from the queue
    // snapshot when there is one (see lib/api-queue.test.ts).
    const user = userEvent.setup();
    await startJob(user);

    act(() =>
      emit?.({ type: 'job.status', jobId: 'job-1', status: 'queued', queuePosition: 2 }),
    );
    await screen.findByText('2 of your jobs ahead');

    act(() =>
      emit?.({ type: 'job.status', jobId: 'job-1', status: 'queued', queuePosition: 0 }),
    );
    await screen.findByText('Next up');
  });
});

describe('the Advanced drawer', () => {
  /**
   * The load-bearing property: opening the drawer, reading it, and even
   * unfolding the expert section must not change a single byte of the request.
   * Everything the user has not touched stays with the quality preset, which is
   * what makes the drawer safe to open out of curiosity.
   */
  it('sends nothing extra just because the drawer was opened', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');

    await openAdvanced(user);
    // ...including the second, expert disclosure.
    await user.click(screen.getByRole('button', { name: /sampling method/i }));
    expect(screen.getByLabelText('Sampler')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(Object.keys(created[0]!.advanced ?? {}).sort()).toEqual(['seed', 'seedLocked']);
  });

  it('sends a setting once it is pinned, and stops when it is handed back', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');
    await openAdvanced(user);
    await user.click(screen.getByRole('button', { name: /sampling method/i }));

    // Sampler is the app's own listbox now, not a native <select>: open the
    // combobox and press the row. Same value reaches the form either way.
    await user.click(screen.getByRole('combobox', { name: 'Sampler' }));
    await user.click(screen.getByRole('option', { name: /^DDIM/ }));
    // The header says so with the drawer shut, so an override is never invisible.
    expect(screen.getByText('1 changed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.advanced?.sampler).toBe('ddim');

    // Let the first job finish, or Generate is disabled for being busy.
    act(() => emit?.({ type: 'job.complete', jobId: 'job-1', assets: [] }));
    await screen.findByText('Done');

    // "Use preset" is the way back, and it really does omit the field again —
    // it does not send the preset's value, which would pin it just as hard.
    await user.click(screen.getByRole('button', { name: /use the quality preset.s sampler/i }));
    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(2));
    expect('sampler' in (created[1]!.advanced ?? {})).toBe(false);
  });

  it('says what a value means, not just what it is', async () => {
    // The whole point of the rewrite: a number with no consequence attached is
    // not a control a non-technical user can use.
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await openAdvanced(user);

    const guidance = screen.getByLabelText(/follow the prompt/i);
    expect(guidance).toHaveAttribute('aria-valuetext', expect.stringContaining('Balanced'));

    const steps = screen.getByLabelText(/^detail$/i);
    expect(steps).toHaveAttribute('aria-valuetext', expect.stringContaining('28 steps'));
    // ...and the cost of that setting, in seconds, beside it.
    expect(screen.getByText(/about 8 seconds/i)).toBeInTheDocument();

    // The seed's lock is explained in words, not by which padlock is lit.
    expect(screen.getByText(/a new number each time/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /lock the seed/i }));
    expect(screen.getByText(/reuses this number/i)).toBeInTheDocument();
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

    expect(screen.getByRole('slider', { name: /image count/i })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Video' }));

    // The list is now the video checkpoints, and the image ones are gone.
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Hunyuan/i })).toHaveAttribute(
        'aria-disabled',
        'false',
      ),
    );
    expect(screen.queryByRole('radio', { name: /SDXL Base/i })).not.toBeInTheDocument();

    // And the controls follow: a clip has a length and a rate, not a count.
    expect(screen.queryByRole('slider', { name: /image count/i })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /duration/i })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: /frame rate/i })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Hunyuan/i }));
    await user.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.kind).toBe('txt2vid');
    expect(created[0]!.modelId).toBe('model-hunyuan');
    expect(created[0]!.batchSize).toBe(1);
    expect(created[0]!.video).toMatchObject({ lengthSeconds: 4, fps: 25 });
  });

  it('offers the switch when nothing in this mode can run', async () => {
    const user = userEvent.setup();
    const { workflowsApi } = await import('../lib/api-jobs');
    vi.mocked(workflowsApi.capabilities).mockResolvedValueOnce({
      byFamily: { sdxl: ['txt2img'] },
      live: true,
    });
    render(
      <>
        <ModeToggle />
        <CreatePage />
      </>,
    );
    await screen.findByRole('radio', { name: /SDXL Base/i });

    // No family here has a video template, so Video lists nothing runnable
    // (the template-less checkpoints, blocked) and the picker has to point
    // the way back rather than leave the user stuck.
    await user.click(screen.getByRole('radio', { name: 'Video' }));

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

describe('what the picker hides', () => {
  // The rule: hide what is impossible, keep what is not yet possible.

  it('keeps a needs-setup model visible, with the remedy the server gave', async () => {
    const user = userEvent.setup();
    const { readinessApi } = await import('../lib/api-jobs');
    vi.mocked(readinessApi.get).mockImplementation(async (_backend, modelId, capability) => {
      if (modelId === 'model-ltx' && capability === 'txt2vid') {
        return {
          state: 'blocked' as const,
          templateLabel: 'Text to video (LTX-Video)',
          isFallback: false,
          summary:
            'the checkpoint is in a folder ComfyUI cannot load it from and the T5 text encoder is not installed.',
          steps: ['Move it into models/checkpoints.'],
        };
      }
      if (modelId === 'model-hunyuan') {
        return { ...UNKNOWN, state: 'no-template' as const };
      }
      return UNKNOWN;
    });

    render(
      <>
        <ModeToggle />
        <CreatePage />
      </>,
    );
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.click(screen.getByRole('radio', { name: 'Video' }));

    // Hunyuan has no workflow anywhere: gone. LTX has one and the machine is
    // not set up for it: present, blocked, and it says what to do.
    const ltx = await screen.findByRole('radio', { name: /LTX Video/i });
    expect(ltx).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() =>
      expect(screen.queryByRole('radio', { name: /Hunyuan/i })).not.toBeInTheDocument(),
    );

    await user.click(ltx);
    expect(await screen.findByText(/T5 text encoder is not installed/i)).toBeInTheDocument();
    expect(screen.getByText(/Move it into models\/checkpoints\./i)).toBeInTheDocument();
  });

  it('shows everything when readiness cannot be asked', async () => {
    // Point 4: the GPU box has been down for days. An unreachable backend must
    // never be the reason a model vanishes.
    const { readinessApi, workflowsApi } = await import('../lib/api-jobs');
    vi.mocked(readinessApi.get).mockResolvedValue(UNKNOWN);
    // ...and with no live capability list either, nothing is evidence of
    // absence, so even the unknown family is drawn rather than hidden.
    vi.mocked(workflowsApi.capabilities).mockResolvedValueOnce({
      byFamily: { sdxl: ['txt2img'] },
      live: false,
    });

    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    const mystery = await screen.findByRole('radio', { name: /Mystery Mix/i });
    expect(mystery).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();
  });

  it('explains an empty grid instead of drawing nothing', async () => {
    const user = userEvent.setup();
    const { workflowsApi } = await import('../lib/api-jobs');
    vi.mocked(workflowsApi.capabilities).mockResolvedValueOnce({
      byFamily: { sdxl: ['txt2img'] },
      live: true,
    });
    render(
      <>
        <ModeToggle />
        <CreatePage />
      </>,
    );
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.click(screen.getByRole('radio', { name: 'Video' }));

    expect(await screen.findByText(/No video models are installed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch to image mode/i })).toBeInTheDocument();
  });

  it('never leaves a hidden model selected when the mode changes', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ModeToggle />
        <CreatePage />
      </>,
    );
    const juggernaut = await screen.findByRole('radio', { name: /Juggernaut/i });
    await user.click(juggernaut);
    expect(juggernaut).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: 'Video' }));

    // The image model it was on is not in this list at all now, so the repair
    // has to land on one of the tiles actually on screen — never on a hidden
    // one, and never on nothing while a runnable tile exists.
    const checked = await waitFor(() => {
      const tiles = within(screen.getByRole('radiogroup', { name: 'Model' })).getAllByRole('radio');
      const on = tiles.filter((tile) => tile.getAttribute('aria-checked') === 'true');
      expect(on).toHaveLength(1);
      return on[0]!;
    });
    expect(checked).toHaveAccessibleName(/Hunyuan|LTX/i);
    expect(checked).toHaveAttribute('aria-disabled', 'false');
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

describe('the first paint', () => {
  /** Hold every readiness probe open until the test lets it answer. */
  function gatedReadiness(answers: Record<string, 'ready' | 'no-template'>) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      install: async () => {
        const { readinessApi } = await import('../lib/api-jobs');
        vi.mocked(readinessApi.get).mockImplementation(async (_backend, modelId) => {
          await gate;
          const state = answers[modelId];
          return state ? { ...UNKNOWN, state } : UNKNOWN;
        });
      },
      release: () => act(() => release()),
    };
  }

  const tiles = () => within(screen.getByRole('radiogroup', { name: 'Model' })).getAllByRole('radio');

  it('draws no verdict before the probes answer, and the right one after', async () => {
    // The reported flash: all six checkpoints painted, five badged
    // "No template", then corrected to three plus a hidden count. The badge was
    // not merely ugly mid-flight, it was wrong — it came from the hardcoded
    // capability mirror, which knows one family.
    const probes = gatedReadiness({ 'model-sdxl': 'ready', 'model-sdxl-2': 'ready' });
    await probes.install();

    render(<CreatePage />);

    // The tiles themselves are known from /models and paint at once...
    await screen.findByRole('radiogroup', { name: 'Model' });
    expect(tiles().length).toBeGreaterThan(2);
    // ...but nothing claims a verdict yet.
    expect(screen.queryByText(/No template/i)).toBeNull();
    expect(screen.queryByText(/models? hidden/i)).toBeNull();
    for (const tile of tiles()) expect(tile).toHaveAttribute('aria-disabled', 'false');

    // And the answers, when they land, are the real ones.
    probes.release();
    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(screen.getByText(/models? hidden/i)).toBeInTheDocument();
  });

  it('does not preselect or clear a model on an unanswered probe', async () => {
    const probes = gatedReadiness({ 'model-sdxl': 'ready' });
    await probes.install();

    render(<CreatePage />);
    await screen.findByRole('radiogroup', { name: 'Model' });

    // Nothing is chosen on a guess: preselecting here would visibly swap the
    // model out from under the user a moment later.
    expect(tiles().every((tile) => tile.getAttribute('aria-checked') === 'false')).toBe(true);

    probes.release();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /SDXL Base/i })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
  });
});

describe('extra styles', () => {
  it('is a section of the panel, not something buried in Advanced', async () => {
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });

    // Visible with the Advanced drawer shut, which is the point of the move.
    expect(screen.getByRole('button', { name: /add a style/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show advanced|advanced/i })).toBeTruthy();
  });

  it('offers what fits the chosen checkpoint and hides what cannot run', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });

    await user.click(screen.getByRole('button', { name: /add a style/i }));

    const list = screen.getByRole('listbox', { name: /extra styles/i });
    expect(within(list).getByText('Film Grain XL')).toBeInTheDocument();
    // Unknown family is offered, marked, never hidden: it is the normal state
    // of a locally discovered file.
    expect(within(list).getByText('Pytorch LoRA Weights')).toBeInTheDocument();
    // Trained for SD 1.5 against an SDXL checkpoint: impossible, so hidden.
    expect(within(list).queryByText('Hyper SD15 1step LoRA')).toBeNull();

    // Hidden, but counted honestly and reachable. (The model grid has a
    // reveal of its own, hence scoping this to the picker.)
    const picker = screen.getByRole('dialog', { name: /add an extra style/i });
    await user.click(within(picker).getByRole('button', { name: /show anyway/i }));
    expect(within(list).getByText('Hyper SD15 1step LoRA')).toBeInTheDocument();
  });

  it('adds a style, stacks a second, and sends both with their weights', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');

    await user.click(screen.getByRole('button', { name: /add a style/i }));
    await user.click(screen.getByRole('option', { name: /Film Grain XL/ }));
    expect(screen.getByRole('button', { name: /remove film grain xl/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add another/i }));
    await user.click(screen.getByRole('option', { name: /Pytorch LoRA Weights/ }));

    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.loras).toEqual([
      { modelId: 'lora-film', weight: 0.7 },
      { modelId: 'lora-unknown', weight: 0.7 },
    ]);
  });

  it('removes one again, and sends nothing when none are left', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');

    await user.click(screen.getByRole('button', { name: /add a style/i }));
    await user.click(screen.getByRole('option', { name: /Film Grain XL/ }));
    await user.click(screen.getByRole('button', { name: /remove film grain xl/i }));

    await user.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.loras).toBeUndefined();
  });

  it('closes the picker on Escape and puts focus back on the button', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });

    const add = screen.getByRole('button', { name: /add a style/i });
    await user.click(add);
    expect(screen.getByRole('dialog', { name: /add an extra style/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(add).toHaveFocus();
  });

  it('filters the picker by typing, and chooses with the keyboard', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await screen.findByRole('radio', { name: /SDXL Base/i });
    await user.type(screen.getByRole('textbox', { name: /prompt/i }), 'neon');

    await user.click(screen.getByRole('button', { name: /add a style/i }));
    await user.type(screen.getByRole('combobox', { name: /search extra styles/i }), 'pytorch');

    const list = screen.getByRole('listbox', { name: /extra styles/i });
    expect(within(list).queryByText('Film Grain XL')).toBeNull();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /remove pytorch lora weights/i })).toBeInTheDocument();
  });
});

function formatted(seed: number): string {
  return String(seed).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
