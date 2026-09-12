/**
 * The cost model and the ledger it feeds.
 *
 * Neither is asserted against absolute numbers, and that is the point: the
 * score is an *ordering* with arbitrary constants in it (see the header of
 * cost.ts), so a test pinning "this job is 11.4 GB" would be pinning the
 * constants rather than the behaviour, and would have to be rewritten the first
 * time anyone tuned them. Every assertion here is a comparison or a verdict.
 */
import { describe, expect, it } from 'vitest';

import { sizeOfJob, formatScore } from './cost.js';
import { assess, NO_EVIDENCE, type FitEvidence } from './fit.js';
import { img2vidSvdManifest } from '../workflows/img2vid-svd.js';
import { txt2imgSdxlManifest } from '../workflows/txt2img-sdxl.js';
import type { GenerationParams } from '@comfy/shared';

const SVD_BYTES = 9_560_000_000;

function videoJob(over: Partial<{ seconds: number; fps: number }> = {}) {
  const params = {
    kind: 'img2vid',
    prompt: 'x',
    modelId: 'm',
    quality: 'fast',
    aspect: '16:9',
    batchSize: 1,
    video: { lengthSeconds: over.seconds ?? 1, fps: over.fps ?? 25 },
  } as GenerationParams;
  return sizeOfJob({
    manifest: img2vidSvdManifest,
    params,
    width: 512,
    height: 288,
    fileBytes: [SVD_BYTES],
  });
}

describe('the cost model orders jobs the way they actually get harder', () => {
  it('makes a longer clip cost more', () => {
    expect(videoJob({ seconds: 1 }).score).toBeLessThan(videoJob({ seconds: 2 }).score);
  });

  it('grows the activation term with length and leaves the weights alone', () => {
    // The shape of the real failure: the model loads fine and the decode dies.
    const short = videoJob({ seconds: 1 });
    const long = videoJob({ seconds: 2 });
    expect(long.weightBytes).toBe(short.weightBytes);
    expect(long.activationBytes).toBeGreaterThan(short.activationBytes);
  });

  it('counts the frames it will really sample, not the ones asked for', () => {
    // Snapped through the same `videoFrameCount` the compiler uses.
    expect(videoJob({ seconds: 1, fps: 25 }).frames).toBe(25);
  });

  it('makes a bigger picture cost more', () => {
    const small = sizeOfJob({
      manifest: txt2imgSdxlManifest,
      params: { kind: 'txt2img', prompt: 'x', modelId: 'm', quality: 'fast', aspect: '1:1', batchSize: 1 } as GenerationParams,
      width: 512, height: 512, fileBytes: [6_900_000_000],
    });
    const big = sizeOfJob({
      manifest: txt2imgSdxlManifest,
      params: { kind: 'txt2img', prompt: 'x', modelId: 'm', quality: 'fast', aspect: '1:1', batchSize: 1 } as GenerationParams,
      width: 1024, height: 1024, fileBytes: [6_900_000_000],
    });
    expect(big.score).toBeGreaterThan(small.score);
  });

  it('shares one copy of the weights across a batch', () => {
    // Most of why batching is worth doing; a score that missed it would push
    // people away from the cheap thing.
    const base = { manifest: txt2imgSdxlManifest, width: 1024, height: 1024, fileBytes: [6_900_000_000] };
    const params = (batchSize: number) =>
      ({ kind: 'txt2img', prompt: 'x', modelId: 'm', quality: 'fast', aspect: '1:1', batchSize }) as GenerationParams;
    const one = sizeOfJob({ ...base, params: params(1) });
    const four = sizeOfJob({ ...base, params: params(4) });
    expect(four.weightBytes).toBe(one.weightBytes);
    expect(four.score).toBeLessThan(one.score * 4);
  });

  it('says so when a file size was missing rather than quietly underestimating', () => {
    const known = videoJob();
    const unknown = sizeOfJob({
      manifest: img2vidSvdManifest,
      params: { kind: 'img2vid', prompt: 'x', modelId: 'm', quality: 'fast', aspect: '16:9', batchSize: 1, video: { lengthSeconds: 1, fps: 25 } } as GenerationParams,
      width: 512, height: 288, fileBytes: [null],
    });
    expect(known.partial).toBe(false);
    expect(unknown.partial).toBe(true);
    expect(unknown.weightBytes).toBe(0);
  });
});

describe('the ledger says nothing until a machine has taught it something', () => {
  it('is unknown with no observations, which is exactly today’s behaviour', () => {
    const answer = assess(10_000, NO_EVIDENCE);
    expect(answer.verdict).toBe('unknown');
    expect(answer.note).toBeNull();
  });
});

describe('the ledger’s decision table', () => {
  const evidence = (over: Partial<FitEvidence> = {}): FitEvidence => ({
    ceiling: 100,
    floor: 200,
    observations: 12,
    ...over,
  });

  it('calls a job smaller than a known success a fit', () => {
    expect(assess(90, evidence()).verdict).toBe('fits');
    expect(assess(100, evidence()).verdict).toBe('fits');
  });

  it('calls a job at or above a known failure too big', () => {
    expect(assess(200, evidence()).verdict).toBe('too-big');
    expect(assess(500, evidence()).verdict).toBe('too-big');
  });

  it('admits it does not know in the gap between them', () => {
    const answer = assess(150, evidence());
    expect(answer.verdict).toBe('unproven');
    expect(answer.note).toMatch(/larger than anything this machine has finished/);
  });

  it('lets a failure beat a success when the evidence contradicts itself', () => {
    // A 9 GB job succeeded on Monday, an 8 GB one failed on Tuesday because
    // something else had the card. Real machines do this, and the one thing we
    // must not do is promise it will work.
    const crossed = evidence({ ceiling: 900, floor: 800 });
    expect(assess(850, crossed).verdict).toBe('too-big');
    expect(assess(820, crossed).verdict).toBe('too-big');
  });

  it('is unproven when only failures are known and this job is under them', () => {
    const onlyFailures = evidence({ ceiling: null, floor: 200 });
    expect(assess(50, onlyFailures).verdict).toBe('unproven');
  });

  it('never promises a fit from a failure alone', () => {
    const onlyFailures = evidence({ ceiling: null, floor: 200 });
    expect(assess(50, onlyFailures).verdict).not.toBe('fits');
  });
});

describe('formatScore', () => {
  it('reads as a size a person would say out loud', () => {
    expect(formatScore(11.4 * 1024 ** 3)).toBe('11.4 GB');
    expect(formatScore(512 * 1024 ** 2)).toBe('512 MB');
  });
});

describe('the ledger only ever reorders machines, never excludes them', () => {
  // `rankByFit` is private; its contract is stated through `assess`, which is
  // the whole of its decision. These pin the properties the caller relies on.

  it('treats an unassessable machine as fine rather than demoting it', () => {
    // A machine with no history must not lose to one that merely has some.
    expect(assess(1000, NO_EVIDENCE).verdict).toBe('unknown');
    expect(assess(1000, NO_EVIDENCE).verdict).not.toBe('too-big');
  });

  it('demotes only on a failure at or below this size', () => {
    // The single condition that moves a machine to the back of the queue.
    const seen: FitEvidence = { ceiling: 100, floor: 500, observations: 20 };
    expect(assess(499, seen).verdict).not.toBe('too-big');
    expect(assess(500, seen).verdict).toBe('too-big');
  });
});
