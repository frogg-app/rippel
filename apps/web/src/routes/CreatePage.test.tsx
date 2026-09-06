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
import type { GenerationParams, Job, JobEvent, Model } from '@comfy/shared';

const capabilities = { byFamily: { sdxl: ['txt2img'] }, live: true };

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

beforeEach(() => {
  created.length = 0;
  localStorage.clear();
  sessionStorage.clear();
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

  it('will not let a model with no template be chosen', async () => {
    render(<CreatePage />);
    const blocked = await screen.findByRole('radio', { name: /Hunyuan/i });
    expect(blocked).toBeDisabled();
    expect(screen.getByText(/no workflow template/i)).toBeInTheDocument();

    // ...and the runnable one is preselected, so the screen opens usable.
    expect(screen.getByRole('radio', { name: /SDXL Base/i })).toHaveAttribute(
      'aria-checked',
      'true',
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

function formatted(seed: number): string {
  return String(seed).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
