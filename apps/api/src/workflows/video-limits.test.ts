import { describe, expect, it } from 'vitest';
import { TEMPLATES } from './registry.js';
import { videoLimitsFor } from './video-limits.js';
import { compile } from '../compiler/compile.js';
import { fitVideoState, initialFormState, toGenerationParams } from '../../../web/src/create/form.js';

describe('video controls and the compiler agree', () => {
  for (const template of TEMPLATES.filter((t) => videoLimitsFor(t.manifest))) {
    it(`${template.manifest.id}: defaults and both duration bounds compile at every frame rate`, () => {
      const limits = videoLimitsFor(template.manifest)!;
      const form = initialFormState();
      form.kind = template.manifest.capability;
      form.modelId = 'model';
      form.prompt = 'A wave';
      if (form.kind === 'img2vid') {
        form.initImage = { source: { from: 'upload', uploadId: 'upload' }, previewUrl: '', influence: 0.7 };
      }
      for (let fps = limits.fps.min; fps <= limits.fps.max; fps += limits.fps.step) {
        for (const lengthSeconds of [0, 4, 1000]) {
          form.video = fitVideoState({ lengthSeconds, fps }, limits);
          expect(() => compile({ template, params: toGenerationParams(form),
            modelFilenames: { model: 'model.safetensors' }, jobId: 'test' })).not.toThrow();
        }
      }
    });
  }

  it('returns motion limits and keeps SVD shorter than LTX at the same rate', () => {
    const svd = videoLimitsFor(TEMPLATES.find((t) => t.manifest.id === 'img2vid-svd')!.manifest)!;
    const ltx = videoLimitsFor(TEMPLATES.find((t) => t.manifest.id === 'img2vid-ltxv')!.manifest)!;
    expect(svd.motion).toEqual({ min: 1, max: 1023, step: 1 });
    expect(fitVideoState(initialFormState().video, svd)).toEqual({ fps: 25, lengthSeconds: 1 });
    expect(svd.frames.max / 25).toBeLessThan(ltx.frames.max / 25);
  });
});
