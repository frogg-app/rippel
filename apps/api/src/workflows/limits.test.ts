/**
 * The frame budget the form reads. These tests exist to hold one property that
 * no single assertion can state: for every video template, a duration the
 * derived limits allow is a duration the compiler accepts. The bug this fixes
 * was the two disagreeing, so the last test walks the real templates and checks
 * the derivation against `videoFrameCount` itself rather than against numbers
 * copied out of the manifests.
 */

import { describe, expect, it } from 'vitest';

import { videoFrameCount } from '../compiler/compile.js';
import { TEMPLATES, videoLimitsFor } from './index.js';
import { img2vidSvdManifest, SVD_MAX_FRAMES, SVD_MIN_FRAMES } from './img2vid-svd.js';
import { LTXV_FRAME_QUANTUM, LTXV_MAX_FRAMES } from './presets.js';
import { txt2imgSdxlManifest } from './txt2img-sdxl.js';
import { txt2vidLtxvManifest } from './txt2vid-ltxv.js';
import type { GenerationParams } from '@comfy/shared';

describe('videoLimitsFor', () => {
  it('reports nothing for an image template', () => {
    expect(videoLimitsFor(txt2imgSdxlManifest)).toBeNull();
  });

  it('reads SVD frames straight off the manifest constraint', () => {
    const limits = videoLimitsFor(img2vidSvdManifest);
    expect(limits?.frames).toEqual({ min: SVD_MIN_FRAMES, max: SVD_MAX_FRAMES });
  });

  it('reports no quantum for a family that samples any frame count', () => {
    // SVD is the one video family with no grid; null and 1 mean the same thing
    // to the compiler, and null is what the wire carries.
    expect(videoLimitsFor(img2vidSvdManifest)?.frameQuantum).toBeNull();
  });

  it('reports the grid for a latent-video family', () => {
    const limits = videoLimitsFor(txt2vidLtxvManifest);
    expect(limits?.frameQuantum).toBe(LTXV_FRAME_QUANTUM);
    expect(limits?.frames.max).toBe(LTXV_MAX_FRAMES);
  });

  it('gives SVD and LTX different frame budgets', () => {
    // The whole point: one hardcoded range in the form cannot serve both.
    const svd = videoLimitsFor(img2vidSvdManifest);
    const ltxv = videoLimitsFor(txt2vidLtxvManifest);
    expect(svd?.frames.max).toBeLessThan(ltxv?.frames.max ?? 0);
  });

  it('reports the motion range only where the family has one', () => {
    // SVD's trained motion bucket.
    expect(videoLimitsFor(img2vidSvdManifest)?.motion).toEqual({ min: 1, max: 1023 });
  });

  it('intersects a source bound at more than one path', () => {
    // `fps` is written to both the sampler and the encoder. Both constraints
    // agree today; the derivation must narrow rather than take the first.
    const limits = videoLimitsFor({
      ...img2vidSvdManifest,
      inputs: [
        ...img2vidSvdManifest.inputs.filter((input) => input.source !== 'fps'),
        { path: '18.inputs.fps', source: 'fps', label: 'a', constraint: { kind: 'int', min: 3, max: 30 }, required: true },
        { path: '9.inputs.fps', source: 'fps', label: 'b', constraint: { kind: 'int', min: 10, max: 24 }, required: true },
      ],
    });
    expect(limits?.fps).toEqual({ min: 10, max: 24 });
  });

  it('reports nothing when a video manifest binds no frame count', () => {
    const limits = videoLimitsFor({
      ...img2vidSvdManifest,
      inputs: img2vidSvdManifest.inputs.filter((input) => input.source !== 'frameCount'),
    });
    expect(limits).toBeNull();
  });
});

describe('the limits agree with the compiler', () => {
  const videoTemplates = TEMPLATES.filter(
    (template) =>
      template.manifest.capability === 'txt2vid' || template.manifest.capability === 'img2vid',
  );

  it('covers every video template', () => {
    expect(videoTemplates.length).toBeGreaterThan(0);
    for (const template of videoTemplates) {
      expect(videoLimitsFor(template.manifest), template.manifest.id).not.toBeNull();
    }
  });

  it.each(videoTemplates.map((t) => [t.manifest.id, t] as const))(
    '%s accepts every frame count inside its own limits',
    (_id, template) => {
      const limits = videoLimitsFor(template.manifest);
      if (!limits) throw new Error('no limits');
      const { min, max } = limits.frames;
      const quantum = limits.frameQuantum ?? 1;

      // Walk the grid the compiler snaps onto. Each point must survive the
      // snap unchanged and stay inside the manifest's own ceiling — the
      // property that makes a form built on these numbers safe.
      for (let frames = min; frames <= max; frames += quantum) {
        const params = {
          video: { lengthSeconds: frames / limits.fps.max, fps: limits.fps.max },
        } as GenerationParams;
        const snapped = videoFrameCount(params, template.manifest);
        expect(snapped, `${frames} frames`).toBe(frames);
        expect(snapped).toBeLessThanOrEqual(max);
        expect(snapped).toBeGreaterThanOrEqual(min);
      }
    },
  );
});
