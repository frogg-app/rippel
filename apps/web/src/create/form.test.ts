/**
 * The form's two expensive mistakes:
 *
 *  - the object we POST not matching `GenerationParams`, which the user sees as
 *    a 400 they cannot act on or, worse, a control that silently does nothing;
 *  - the seed doing something other than what the dice and the lock promise,
 *    which quietly destroys the ability to reproduce an image.
 *
 * Both are pure functions, so both are tested here rather than through the DOM.
 */
import { describe, expect, it, vi } from 'vitest';
import type { GenerationParams } from '@comfy/shared';
import {
  ASPECT_RATIOS,
  QUALITY_PRESETS,
  checkSubmittable,
  fromGenerationParams,
  initialFormState,
  prepareSubmit,
  toGenerationParams,
  effectiveKind,
  deriveKind,
  modeOfKind,
} from './form';

function form(overrides: Partial<ReturnType<typeof initialFormState>> = {}) {
  return {
    ...initialFormState(),
    prompt: 'a lone figure on a rain-slick street',
    modelId: 'ac9f0e0e-1111-4222-8333-444455556666',
    ...overrides,
  };
}

describe('toGenerationParams', () => {
  it('produces the required fields and nothing else for a bare form', () => {
    const params = toGenerationParams({
      ...form(),
      advanced: { ...initialFormState().advanced, seed: 42, seedLocked: false },
    });

    // Assigning to the shared type is the actual assertion: an extra or
    // misnamed field is a compile error, and the runtime shape is checked here.
    const typed: GenerationParams = params;
    expect(typed).toEqual({
      kind: 'txt2img',
      prompt: 'a lone figure on a rain-slick street',
      modelId: 'ac9f0e0e-1111-4222-8333-444455556666',
      quality: 'balanced',
      aspect: '1:1',
      batchSize: 1,
      advanced: { seed: 42, seedLocked: false },
    });
  });

  it('trims the prompt and omits an empty negative prompt', () => {
    const params = toGenerationParams(form({ prompt: '  neon  ', negativePrompt: '   ' }));
    expect(params.prompt).toBe('neon');
    expect('negativePrompt' in params).toBe(false);
  });

  it('sends a negative prompt when there is one', () => {
    const params = toGenerationParams(form({ negativePrompt: ' blurry, watermark ' }));
    expect(params.negativePrompt).toBe('blurry, watermark');
  });

  it('omits every advanced knob the user has not touched', () => {
    const params = toGenerationParams(form());
    // Only the seed pair, which always has a value the user can see.
    expect(Object.keys(params.advanced ?? {}).sort()).toEqual(['seed', 'seedLocked']);
  });

  it('sends the advanced knobs the user did touch', () => {
    const state = form();
    const params = toGenerationParams({
      ...state,
      advanced: { ...state.advanced, steps: 34, guidance: 7.5, sampler: 'ddim', scheduler: 'beta' },
    });
    expect(params.advanced).toMatchObject({
      steps: 34,
      guidance: 7.5,
      sampler: 'ddim',
      scheduler: 'beta',
    });
  });

  it('omits loras when there are none, and drops zero-weight ones', () => {
    expect('loras' in toGenerationParams(form())).toBe(false);

    const params = toGenerationParams(
      form({
        loras: [
          { modelId: 'lora-a', weight: 0.7 },
          { modelId: 'lora-b', weight: 0 },
        ],
      }),
    );
    expect(params.loras).toEqual([{ modelId: 'lora-a', weight: 0.7 }]);
  });

  it('carries the quality and aspect values straight from the shared unions', () => {
    for (const quality of QUALITY_PRESETS) {
      expect(toGenerationParams(form({ quality })).quality).toBe(quality);
    }
    for (const aspect of ASPECT_RATIOS) {
      expect(toGenerationParams(form({ aspect })).aspect).toBe(aspect);
    }
  });

  it('refuses to build params with no model rather than sending an empty id', () => {
    expect(() => toGenerationParams(form({ modelId: null }))).toThrow(/no model/i);
  });
});

describe('seed: dice and lock', () => {
  it('rolls a new seed on submit when unlocked', () => {
    const state = form();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const next = prepareSubmit(state);
    vi.restoreAllMocks();

    expect(next.advanced.seed).toBe(2 ** 31);
    expect(next.advanced.seed).not.toBe(state.advanced.seed);
    // And the params carry exactly what the drawer now shows.
    expect(toGenerationParams(next).advanced?.seed).toBe(next.advanced.seed);
  });

  it('reuses the seed on submit when locked', () => {
    const state = form();
    const locked = { ...state, advanced: { ...state.advanced, seed: 874203551, seedLocked: true } };
    const next = prepareSubmit(locked);

    expect(next).toBe(locked); // untouched, not merely equal
    expect(toGenerationParams(next).advanced).toEqual({ seed: 874203551, seedLocked: true });
  });

  it('reports the lock state to the server either way', () => {
    expect(toGenerationParams(form()).advanced?.seedLocked).toBe(false);
    const state = form();
    expect(
      toGenerationParams({ ...state, advanced: { ...state.advanced, seedLocked: true } }).advanced
        ?.seedLocked,
    ).toBe(true);
  });
});

describe('checkSubmittable', () => {
  const ok = { modelSupported: true, busy: false };

  it('needs a prompt', () => {
    expect(checkSubmittable(form({ prompt: '   ' }), ok)).toEqual({
      ok: false,
      reason: 'Write a prompt first.',
    });
  });

  it('needs a model', () => {
    expect(checkSubmittable(form({ modelId: null }), ok).reason).toMatch(/pick a model/i);
  });

  it('refuses a model whose family has no template, rather than letting it 501', () => {
    expect(checkSubmittable(form(), { ...ok, modelSupported: false }).reason).toMatch(
      /no workflow template/i,
    );
  });

  it('refuses while a job is running', () => {
    expect(checkSubmittable(form(), { ...ok, busy: true }).ok).toBe(false);
  });

  it('passes an otherwise complete form', () => {
    expect(checkSubmittable(form(), ok)).toEqual({ ok: true, reason: null });
  });
});

describe('fromGenerationParams (remix)', () => {
  it('refills the form and locks the seed so the remix is reproducible', () => {
    const params: GenerationParams = {
      kind: 'txt2img',
      prompt: 'a cathedral of glass',
      negativePrompt: 'blurry',
      modelId: 'model-9',
      quality: 'high',
      aspect: '16:9',
      batchSize: 4,
      loras: [{ modelId: 'lora-a', weight: 0.4 }],
      advanced: { steps: 50, seed: 12345, seedLocked: false },
    };

    const next = fromGenerationParams(params, initialFormState());

    expect(next.prompt).toBe('a cathedral of glass');
    expect(next.negativeOpen).toBe(true);
    expect(next.quality).toBe('high');
    expect(next.aspect).toBe('16:9');
    expect(next.batchSize).toBe(4);
    expect(next.loras).toEqual([{ modelId: 'lora-a', weight: 0.4 }]);
    expect(next.advanced.steps).toBe(50);
    expect(next.advanced.guidance).toBeNull(); // absent stays absent
    expect(next.advanced.seed).toBe(12345);
    expect(next.advanced.seedLocked).toBe(true);
  });

  it('round-trips: params -> form -> params is the same request', () => {
    const original = toGenerationParams(
      form({ negativePrompt: 'blurry', batchSize: 3, quality: 'fast', aspect: '2:3' }),
    );
    const rebuilt = toGenerationParams(fromGenerationParams(original, initialFormState()));
    // The only difference is the lock, which remix deliberately sets.
    expect(rebuilt).toEqual({ ...original, advanced: { ...original.advanced, seedLocked: true } });
  });
});

describe('a starting image', () => {
  const UPLOAD_ID = '00000000-0000-4000-8000-00000000a001';
  const withInit = () =>
    form({
      initImage: {
        source: { from: 'upload', uploadId: UPLOAD_ID },
        previewUrl: `/api/uploads/${UPLOAD_ID}/thumb`,
        influence: 0.45,
      },
    });

  it('switches the job to img2img without a mode being set anywhere', () => {
    // The capability follows from the request, not from a toggle the user has
    // to remember to flip. A form that sent kind: 'txt2img' with an init
    // reference would be refused by the server, and rightly.
    expect(toGenerationParams(form()).kind).toBe('txt2img');
    expect(toGenerationParams(withInit()).kind).toBe('img2img');
  });

  it('sends the image as a single init reference carrying its influence', () => {
    const params = toGenerationParams(withInit());
    expect(params.references).toEqual([
      { source: { from: 'upload', uploadId: expect.any(String) }, role: 'init', influence: 0.45 },
    ]);
  });

  it('omits references entirely when there is no starting image', () => {
    // Not an empty array: an absent key is what "pure txt2img" means, and the
    // compiler's denoise binding keys off the reference being missing.
    expect(toGenerationParams(form())).not.toHaveProperty('references');
  });

  it('round-trips through remix, rebuilding the preview from the source', () => {
    const params = toGenerationParams(withInit());
    const restored = fromGenerationParams(params, initialFormState());

    // The form holds the *base* kind and re-derives the variant from the
    // starting image, so what round-trips is the effective capability.
    expect(restored.kind).toBe('txt2img');
    expect(effectiveKind(restored)).toBe('img2img');
    expect(toGenerationParams(restored).kind).toBe('img2img');
    expect(restored.initImage?.influence).toBe(0.45);
    // The params only carry ids, so the URL has to be derived again.
    expect(restored.initImage?.previewUrl).toMatch(/^\/api\/uploads\/.+\/thumb$/);
  });
});

describe('deriveKind', () => {
  it('maps mode and starting image onto the four capabilities', () => {
    expect(deriveKind('image', false)).toBe('txt2img');
    expect(deriveKind('image', true)).toBe('img2img');
    expect(deriveKind('video', false)).toBe('txt2vid');
    expect(deriveKind('video', true)).toBe('img2vid');
  });

  it('reads a mode back off any of them', () => {
    expect(modeOfKind('txt2img')).toBe('image');
    expect(modeOfKind('img2img')).toBe('image');
    expect(modeOfKind('txt2vid')).toBe('video');
    expect(modeOfKind('img2vid')).toBe('video');
  });

  it('submits the video capability once the mode says video', () => {
    // The bug this pins: the toggle changed nothing, so a video job was
    // POSTed as txt2img and compiled against an image template.
    const state = { ...initialFormState(), kind: deriveKind('video', false), modelId: 'm', prompt: 'a wave' };
    expect(toGenerationParams(state).kind).toBe('txt2vid');
  });
});
