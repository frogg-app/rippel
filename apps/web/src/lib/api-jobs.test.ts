/**
 * Readiness: the endpoint that decides which models the picker offers.
 *
 * Three answers have to stay distinct, because the screen says something
 * different for each and getting them confused is what the live bug was:
 *
 *   no-template — nobody has written a workflow for this family. Honest dead
 *                 end; the only fix is on our side.
 *   blocked     — the workflow exists and the *machine* is missing a file. The
 *                 useful case, and the one a family-level capability map cannot
 *                 express at all: it was being reported as "No template", which
 *                 told a user their model was unsupported when it was one moved
 *                 file away from working.
 *   unknown     — we could not ask. Never a verdict; the caller falls back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readinessApi } from './api-jobs';

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          status,
          ok: status >= 200 && status < 300,
          json: async () => body,
        }) as Response,
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readinessApi.get', () => {
  it('reports a runnable model as ready, with the template that would run', async () => {
    respond(200, {
      readiness: { ready: true, templateLabel: 'Text to image (SDXL)', isFallback: false },
    });

    const readiness = await readinessApi.get('backend-1', 'model-1', 'txt2img');
    expect(readiness).toMatchObject({
      state: 'ready',
      templateLabel: 'Text to image (SDXL)',
      summary: null,
    });
    expect(readiness.steps).toEqual([]);
  });

  it('turns unmet requirements into a sentence and the steps that fix them', async () => {
    // The live LTX-Video case, verbatim from the server.
    respond(200, {
      readiness: {
        ready: false,
        templateLabel: 'Text to video (LTX-Video)',
        requirements: [
          { id: 'checkpoint', label: 'Model checkpoint', status: 'misfiled' },
          { id: 'text-encoder', label: 'T5 text encoder', status: 'missing' },
        ],
        manualSteps: ['Move it to models/checkpoints/ on that machine and restart ComfyUI.'],
        installable: [{ name: 'comfyanonymous/flux_text_encoders - t5xxl (fp16)' }],
      },
    });

    const readiness = await readinessApi.get('backend-1', 'model-ltx', 'txt2vid');
    expect(readiness.state).toBe('blocked');
    expect(readiness.summary).toBe(
      'the model checkpoint is in a folder ComfyUI cannot load it from and the T5 text encoder is not installed.',
    );
    // The acronym keeps its capitals mid-sentence; the ordinary label does not.
    expect(readiness.summary).not.toMatch(/t5 text/);
    expect(readiness.steps).toEqual([
      'Move it to models/checkpoints/ on that machine and restart ComfyUI.',
      'Install comfyanonymous/flux_text_encoders - t5xxl (fp16).',
    ]);
  });

  it('reads a 400 as "no workflow for this", keeping the server’s wording', async () => {
    respond(400, {
      error: 'bad_request',
      message: 'No txt2vid workflow exists for sdxl models.',
    });

    const readiness = await readinessApi.get('backend-1', 'model-1', 'txt2vid');
    expect(readiness.state).toBe('no-template');
    expect(readiness.summary).toBe('No txt2vid workflow exists for sdxl models.');
  });

  it('says "unknown" — never "no" — when it cannot ask', async () => {
    respond(500, { error: 'boom' });
    await expect(readinessApi.get('b', 'm', 'txt2img')).resolves.toMatchObject({
      state: 'unknown',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(readinessApi.get('b', 'm', 'txt2img')).resolves.toMatchObject({
      state: 'unknown',
    });

    // A 404 is the endpoint not being deployed, which is also not a verdict.
    respond(404, { error: 'Not Found' });
    await expect(readinessApi.get('b', 'm', 'txt2img')).resolves.toMatchObject({
      state: 'unknown',
    });
  });
});
