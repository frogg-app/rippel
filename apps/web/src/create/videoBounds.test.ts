/**
 * The duration and rate controls, bounded per model.
 *
 * The bug these hold shut: the form offered 1 to 6 seconds at up to 25 fps for
 * every model, so picking Stable Video Diffusion and pressing Generate sent 100
 * frames to a template that accepts 25, and the user got a 400 for a value the
 * slider had just told them was fine. The numbers below are the real manifest
 * limits, mirrored from the API's `videoLimitsFor` — `apps/api`'s limits.test.ts
 * is what keeps them honest against the compiler.
 */
import { describe, expect, it } from 'vitest';
import type { VideoLimits } from '@comfy/shared';
import {
  DEFAULT_VIDEO_BOUNDS,
  clampVideo,
  initialFormState,
  toGenerationParams,
  videoBoundsFor,
  videoFrameCount,
} from './form';

/** `img2vid-svd`: 2..25 frames, 3..30 fps, no grid, a trained motion bucket. */
const SVD: VideoLimits = {
  frames: { min: 2, max: 25 },
  frameQuantum: null,
  fps: { min: 3, max: 30 },
  motion: { min: 1, max: 1023 },
};

/** `txt2vid-ltxv`: 9..161 frames on an 8n+1 grid, 8..30 fps. */
const LTXV: VideoLimits = {
  frames: { min: 9, max: 161 },
  frameQuantum: 8,
  fps: { min: 8, max: 30 },
  motion: null,
};

describe('videoBoundsFor', () => {
  it('falls back to the widest range before the server has answered', () => {
    expect(videoBoundsFor(null, 25)).toEqual(DEFAULT_VIDEO_BOUNDS);
  });

  it('gives SVD and LTX different maximum lengths at the same rate', () => {
    // The assertion the whole change exists for.
    expect(videoBoundsFor(SVD, 25).lengthMax).toBe(1);
    expect(videoBoundsFor(LTXV, 25).lengthMax).toBe(6);
  });

  it('lets a lower rate buy a longer SVD clip', () => {
    // 25 frames is one second at 25 fps and two at 12 — same model, same
    // budget, spent differently. This is why the bound is computed per rate.
    expect(videoBoundsFor(SVD, 12).lengthMax).toBe(2);
    expect(videoBoundsFor(SVD, 16).lengthMax).toBe(1.5);
  });

  it('never offers a length whose frames overrun the budget', () => {
    for (const limits of [SVD, LTXV]) {
      for (const fps of videoBoundsFor(limits, 25).fpsOptions) {
        const bounds = videoBoundsFor(limits, fps);
        for (let l = bounds.lengthMin; l <= bounds.lengthMax; l += bounds.lengthStep) {
          const frames = videoFrameCount(l, fps, limits.frameQuantum);
          expect(frames, `${l}s at ${fps}fps`).toBeLessThanOrEqual(limits.frames.max);
          expect(frames, `${l}s at ${fps}fps`).toBeGreaterThanOrEqual(limits.frames.min);
        }
      }
    }
  });

  it('keeps the minimum above the floor even when the quotient rounds below it', () => {
    // 9 frames at 25 fps is 0.36s, which is not on the 0.5 grid; rounding down
    // would offer a length that samples too few frames.
    const bounds = videoBoundsFor(LTXV, 25);
    expect(videoFrameCount(bounds.lengthMin, 25, 8)).toBeGreaterThanOrEqual(9);
  });

  it('drops rate chips the family will not accept', () => {
    const slow: VideoLimits = { ...SVD, fps: { min: 3, max: 16 } };
    expect(videoBoundsFor(slow, 12).fpsOptions).toEqual([12, 16]);
  });

  it('offers one rate rather than none when no chip fits the range', () => {
    const odd: VideoLimits = { ...SVD, fps: { min: 60, max: 60 } };
    expect(videoBoundsFor(odd, 25).fpsOptions).toEqual([60]);
  });
});

describe('videoFrameCount', () => {
  it('rounds up onto the grid, the way the compiler does', () => {
    // 2s at 25fps is 50 frames; the 8n+1 grid's next point up is 57, not 49.
    expect(videoFrameCount(2, 25, 8)).toBe(57);
  });

  it('leaves a count already on the grid alone', () => {
    expect(videoFrameCount(1, 25, 8)).toBe(25);
    expect(videoFrameCount(6.44, 25, 8)).toBe(161);
  });

  it('does not snap a family with no grid', () => {
    expect(videoFrameCount(1, 25, null)).toBe(25);
  });
});

describe('clampVideo', () => {
  it('leaves the form alone when we have no limits to apply', () => {
    expect(clampVideo({ lengthSeconds: 4, fps: 25 }, null)).toEqual({ lengthSeconds: 4, fps: 25 });
  });

  it('brings the default form inside SVD, which is the original bug', () => {
    // 4s at 25 fps is 100 frames against a 25-frame ceiling. Before this, that
    // was submitted and rejected.
    const clamped = clampVideo(initialFormState().video, SVD);
    expect(videoFrameCount(clamped.lengthSeconds, clamped.fps, SVD.frameQuantum)).toBeLessThanOrEqual(
      SVD.frames.max,
    );
  });

  it('leaves a request that already fits untouched', () => {
    expect(clampVideo({ lengthSeconds: 4, fps: 25 }, LTXV)).toEqual({ lengthSeconds: 4, fps: 25 });
  });

  it('moves to the nearest allowed rate, not the first', () => {
    const capped: VideoLimits = { ...LTXV, fps: { min: 8, max: 24 } };
    expect(clampVideo({ lengthSeconds: 2, fps: 25 }, capped).fps).toBe(24);
  });

  it('produces params the SVD template accepts, at defaults', () => {
    // The task's own done-when, stated as the form states it: take the state
    // the screen opens with, clamp it for SVD, and check the frame count the
    // compiler would derive is inside the manifest's range.
    const state = {
      ...initialFormState(),
      kind: 'img2vid' as const,
      prompt: 'a paper boat on a puddle',
      modelId: 'ac9f0e0e-1111-4222-8333-444455556666',
      video: clampVideo(initialFormState().video, SVD),
    };
    const params = toGenerationParams(state);
    expect(params.video).toBeDefined();
    const frames = videoFrameCount(params.video!.lengthSeconds, params.video!.fps, SVD.frameQuantum);
    expect(frames).toBeGreaterThanOrEqual(SVD.frames.min);
    expect(frames).toBeLessThanOrEqual(SVD.frames.max);
    expect(params.video!.fps).toBeGreaterThanOrEqual(SVD.fps.min);
    expect(params.video!.fps).toBeLessThanOrEqual(SVD.fps.max);
  });
});
