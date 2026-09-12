/**
 * The graph rewrite that lets a big model run on a small card.
 *
 * Both input names and both value sets below were read from `/object_info` on
 * ComfyUI 0.35.0, which is the only reason this file is allowed to assert them:
 * a wrong enum value here does not make a job slower, it makes ComfyUI reject
 * the prompt outright.
 */
import { describe, expect, it } from 'vitest';

import { withOffload } from './offload.js';
import { img2vidWan22Ti2v5bGraph } from './img2vid-wan22-ti2v-5b.js';
import { img2vidSvdGraph } from './img2vid-svd.js';
import type { ComfyApiGraph } from './types.js';

describe('profiles that ask for nothing', () => {
  it.each(['fast', 'balanced'] as const)('leaves the graph untouched on %s', (profile) => {
    // Identity, not a deep-equal copy: the common path should cost nothing.
    expect(withOffload(img2vidWan22Ti2v5bGraph, { profile })).toBe(img2vidWan22Ti2v5bGraph);
  });
});

describe('low VRAM', () => {
  const out = withOffload(img2vidWan22Ti2v5bGraph, { profile: 'low-vram' });

  it('moves the text encoder into system memory', () => {
    // The cheap win: a text encoder runs once per prompt and is then dead
    // weight for the whole sample, so this costs seconds and frees gigabytes.
    expect(out['38']!.inputs.device).toBe('cpu');
  });

  it('does not quantise the transformer', () => {
    // `--lowvram` already streams the weights layer by layer, which solves the
    // same problem without changing the numbers the model produces.
    expect(out['37']!.inputs.weight_dtype).toBe('default');
  });

  it('does not disturb anything else', () => {
    expect(out['37']!.inputs.unet_name).toBe(img2vidWan22Ti2v5bGraph['37']!.inputs.unet_name);
    expect(out['3']!.inputs).toEqual(img2vidWan22Ti2v5bGraph['3']!.inputs);
  });

  it('does not mutate the template’s own graph', () => {
    // These objects are module-level singletons shared by every job.
    expect(img2vidWan22Ti2v5bGraph['38']!.inputs.device).toBe('default');
  });
});

describe('minimal VRAM', () => {
  const out = withOffload(img2vidWan22Ti2v5bGraph, { profile: 'minimal-vram' });

  it('quantises the transformer as it loads', () => {
    // A real trade — the output changes — taken only where the alternative is
    // not running at all.
    expect(out['37']!.inputs.weight_dtype).toBe('fp8_e4m3fn');
  });

  it('still keeps the encoder off the card', () => {
    expect(out['38']!.inputs.device).toBe('cpu');
  });
});

describe('graphs it cannot help', () => {
  it('leaves a checkpoint-only graph alone', () => {
    // SVD loads model, CLIP-Vision and VAE from one file through
    // `ImageOnlyCheckpointLoader`, which has no per-part dial. The launch flags
    // are the whole lever there, and pretending otherwise would be a setting
    // that appears to apply and does nothing.
    expect(withOffload(img2vidSvdGraph, { profile: 'minimal-vram' })).toBe(img2vidSvdGraph);
  });

  it('will not invent an input the node does not declare', () => {
    // A graph authored against an older ComfyUI may have no `device`. Adding
    // one would turn a memory optimisation into a prompt ComfyUI refuses —
    // strictly worse than doing nothing.
    const old: ComfyApiGraph = {
      '1': { class_type: 'CLIPLoader', inputs: { clip_name: 't5.safetensors', type: 'wan' } },
    };
    const out = withOffload(old, { profile: 'minimal-vram' });
    expect(out['1']!.inputs).not.toHaveProperty('device');
    expect(out).toBe(old);
  });
});
