/**
 * Wan 2.2 TI2V 5B: the things the generic template sweeps in workflows.test.ts
 * cannot check, because they are claims about *this* family rather than about
 * any manifest.
 *
 * The graph's wiring is not re-asserted here. The path tests already resolve
 * every manifest path against the graph, and the structural check that matters
 * more than either was done against the live backend — see the note at the end.
 */

import { describe, expect, it } from 'vitest';

import { compile } from '../compiler/compile.js';
import { familyFromFilename } from '../models/family.js';
import { findTemplate } from './registry.js';
import { videoLimitsFor } from './limits.js';
import {
  WAN22_TEXT_ENCODER_REQUIREMENT,
  WAN22_VAE_REQUIREMENT,
  img2vidWan22Ti2v5bManifest,
  img2vidWan22Ti2v5bTemplate,
} from './img2vid-wan22-ti2v-5b.js';
import { WAN22_FRAME_QUANTUM, WAN22_MAX_FRAMES } from './presets.js';
import type { GenerationParams } from '@comfy/shared';

const MODEL_ID = 'ac9f0e0e-1111-4222-8333-444455556666';
const FILENAME = 'wan2.2_ti2v_5B_fp16.safetensors';

describe('the 5B family is told apart from Wan at large', () => {
  it('recognises the TI2V 5B filename as its own family', () => {
    expect(familyFromFilename(FILENAME)).toBe('wan2.2-ti2v-5b');
  });

  it('matches either word order', () => {
    expect(familyFromFilename('wan2.2_5B_ti2v.safetensors')).toBe('wan2.2-ti2v-5b');
  });

  it('leaves every other Wan model on the plain family', () => {
    // The point of the split: these need `WanImageToVideo`, CLIP-Vision and an
    // expert pair, and must not be routed to this graph.
    expect(familyFromFilename('wan2.2_i2v_A14B_fp8_scaled.safetensors')).toBe('wan');
    expect(familyFromFilename('wan2.1_t2v_14B_fp16.safetensors')).toBe('wan');
  });

  it('needs both halves, not either one', () => {
    // "5b" alone names no family, and "ti2v" alone does not say which size.
    expect(familyFromFilename('some_5B_model.safetensors')).toBeNull();
    expect(familyFromFilename('ti2v_something.safetensors')).toBeNull();
  });
});

describe('the registry routes the 5B model here', () => {
  it('resolves img2vid for the family', () => {
    expect(findTemplate('img2vid', 'wan2.2-ti2v-5b')?.manifest.id).toBe('img2vid-wan22-ti2v-5b');
  });

  it('does not claim txt2vid, which this manifest does not implement', () => {
    const found = findTemplate('txt2vid', 'wan2.2-ti2v-5b');
    expect(found?.manifest.id).not.toBe('img2vid-wan22-ti2v-5b');
  });
});

describe('its companions are Wan files, not the T5 the other families use', () => {
  it('refuses a T5-XXL as the text encoder', () => {
    // A backend holding only the LTX/FLUX encoder must report a gap rather than
    // load a model with a different tensor layout.
    expect(WAN22_TEXT_ENCODER_REQUIREMENT.match.filename!.test('t5xxl_fp16.safetensors')).toBe(
      false,
    );
    expect(
      WAN22_TEXT_ENCODER_REQUIREMENT.match.filename!.test('umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
    ).toBe(true);
  });

  it('refuses the Wan 2.1 VAE, which decodes 2.2 latents as noise', () => {
    const pattern = WAN22_VAE_REQUIREMENT.match.filename!;
    expect(pattern.test('wan_2.1_vae.safetensors')).toBe(false);
    expect(pattern.test('wan2.2_vae.safetensors')).toBe(true);
  });
});

describe('its video limits', () => {
  it('reports the 4n+1 grid the latent node declares', () => {
    const limits = videoLimitsFor(img2vidWan22Ti2v5bManifest);
    expect(limits?.frameQuantum).toBe(WAN22_FRAME_QUANTUM);
    expect(limits?.frames.max).toBe(WAN22_MAX_FRAMES);
  });

  it('offers no motion control, because the family has none', () => {
    expect(videoLimitsFor(img2vidWan22Ti2v5bManifest)?.motion).toBeNull();
  });
});

describe('compiling it', () => {
  function params(over: Partial<GenerationParams> = {}): GenerationParams {
    return {
      kind: 'img2vid',
      prompt: 'a street musician plays in a subway station',
      modelId: MODEL_ID,
      quality: 'balanced',
      aspect: '16:9',
      batchSize: 1,
      video: { lengthSeconds: 2, fps: 24 },
      ...over,
    } as GenerationParams;
  }
  const build = (p: GenerationParams) =>
    compile({
      params: p,
      template: img2vidWan22Ti2v5bTemplate,
      modelFilenames: { [MODEL_ID]: FILENAME },
      jobId: 'job' as never,
    });

  it('snaps the frame count onto 4n+1', () => {
    // 2s at 24fps is 48 frames; the grid's next point up is 49.
    expect(build(params()).graph['55']!.inputs.length).toBe(49);
  });

  it('writes the model into the UNet loader, not a checkpoint loader', () => {
    expect(build(params()).graph['37']!.inputs.unet_name).toBe(FILENAME);
  });

  it('binds the rate only on CreateVideo', () => {
    // Wan 2.2 TI2V takes no rate as conditioning; only the muxer needs it.
    const graph = build(params()).graph;
    expect(graph['57']!.inputs.fps).toBe(24);
    expect(graph['3']!.inputs).not.toHaveProperty('fps');
  });

  it('keeps the reference negative prompt when none is given', () => {
    // Optional binding, so the graph's own literal stands rather than being
    // overwritten with an empty string.
    const text = build(params()).graph['7']!.inputs.text;
    expect(typeof text).toBe('string');
    expect(String(text).length).toBeGreaterThan(50);
  });

  it('sends a given negative prompt instead', () => {
    const graph = build(params({ negativePrompt: 'blurry, static' })).graph;
    expect(graph['7']!.inputs.text).toBe('blurry, static');
  });

  it('takes the first frame at node 10, where dispatch delivers it', () => {
    // Load-bearing: `withInitImage` is called with no node id, so the picture
    // always goes to '10'. A renumbered LoadImage would silently lose it.
    expect(img2vidWan22Ti2v5bTemplate.graph['10']!.class_type).toBe('LoadImage');
  });

  it('rejects a clip longer than the family can sample', () => {
    // Out of range is refused, not clamped.
    expect(() => build(params({ video: { lengthSeconds: 10, fps: 24 } } as never))).toThrow(
      /Frames/,
    );
  });
});
