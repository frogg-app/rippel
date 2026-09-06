/**
 * The compiler against the real, hand-authored template.
 *
 * Everything else in this directory runs on fixtures, which is right for
 * covering edge cases but proves nothing about the template we actually ship:
 * the manifest and the compiler were written independently against a shared
 * idea of the format, and a mismatch between them — a path that no longer
 * resolves, a `source` the compiler has no case for, a preset key it cannot
 * find — would be invisible to a fixture-based suite and fatal in production.
 *
 * This is the test that fails if those two drift apart again.
 */

import type { GenerationParams } from '@comfy/shared';
import { describe, expect, it } from 'vitest';

import { compile } from '../compile.js';
import { txt2imgSdxlTemplate } from '../../workflows/txt2img-sdxl.js';

const CHECKPOINT_ID = '00000000-0000-4000-8000-000000000001';
const LORA_ID = '00000000-0000-4000-8000-00000000000a';
const JOB_ID = '00000000-0000-4000-8000-0000000000f1';

const modelFilenames = {
  [CHECKPOINT_ID]: 'sd_xl_base_1.0.safetensors',
  [LORA_ID]: 'detail-tweaker.safetensors',
};

function params(overrides: Partial<GenerationParams> = {}): GenerationParams {
  return {
    kind: 'txt2img',
    prompt: 'a lighthouse in a storm',
    modelId: CHECKPOINT_ID,
    quality: 'balanced',
    aspect: '1:1',
    batchSize: 1,
    ...overrides,
  };
}

function run(overrides: Partial<GenerationParams> = {}) {
  return compile({
    params: params(overrides),
    template: txt2imgSdxlTemplate,
    modelFilenames,
    jobId: JOB_ID,
  });
}

describe('compiling the shipped txt2img-sdxl template', () => {
  it('resolves every manifest input the template declares', () => {
    const { substitutions } = run({ negativePrompt: 'blurry' });
    const written = new Set(substitutions.map((s) => s.path));

    // Every required input must have been written. Optional ones may be absent
    // by design — that is what "keep the graph's own literal" means.
    for (const input of txt2imgSdxlTemplate.manifest.inputs) {
      if (input.required) expect(written, `missing ${input.path}`).toContain(input.path);
    }
  });

  it('produces a graph ComfyUI would accept', () => {
    const { graph, resolved } = run({ aspect: '16:9', quality: 'high', batchSize: 2 });

    for (const [id, node] of Object.entries(graph)) {
      expect(typeof node.class_type, `node ${id}`).toBe('string');
      expect(typeof node.inputs, `node ${id}`).toBe('object');
    }

    expect(graph['6']!.inputs.text).toBe('a lighthouse in a storm');
    expect(graph['4']!.inputs.ckpt_name).toBe('sd_xl_base_1.0.safetensors');
    // The 16:9 SDXL bucket, from the manifest's table — not arithmetic.
    expect(graph['5']!.inputs).toMatchObject({ width: 1344, height: 768, batch_size: 2 });
    // The 'high' preset, since the Advanced drawer overrode nothing.
    expect(graph['3']!.inputs).toMatchObject({ steps: 45, cfg: 7.0, seed: resolved.seed });
    // Namespaced so /history reconciliation can match files back to the job.
    expect(graph['9']!.inputs.filename_prefix).toContain(JOB_ID);
  });

  it('leaves the shared template untouched', () => {
    const before = JSON.stringify(txt2imgSdxlTemplate.graph);
    run({ prompt: 'something else', loras: [{ modelId: LORA_ID, weight: 0.7 }] });
    expect(JSON.stringify(txt2imgSdxlTemplate.graph)).toBe(before);
  });

  it('splices a LoRA into the real graph and rewires its consumers', () => {
    const { graph, resolved } = run({ loras: [{ modelId: LORA_ID, weight: 0.7 }] });

    expect(resolved.loraNodeIds).toHaveLength(1);
    const loraId = resolved.loraNodeIds[0]!;
    expect(graph[loraId]!.class_type).toBe('LoraLoader');
    expect(graph[loraId]!.inputs).toMatchObject({
      lora_name: 'detail-tweaker.safetensors',
      strength_model: 0.7,
      strength_clip: 0.7,
    });

    // The sampler and both text encoders must now read through the LoRA, not
    // straight from the checkpoint — the failure mode this guards against is a
    // graph that runs fine while silently ignoring the LoRA entirely.
    expect(graph['3']!.inputs.model).toEqual([loraId, 0]);
    expect(graph['6']!.inputs.clip).toEqual([loraId, 1]);
    expect(graph['7']!.inputs.clip).toEqual([loraId, 1]);
    // The VAE still comes from the checkpoint; LoRAs have no VAE output.
    expect(graph['8']!.inputs.vae).toEqual(['4', 2]);
  });

  it('rejects a request the manifest says is out of range', () => {
    expect(() => run({ batchSize: 99 })).toThrow(/Images/);
    expect(() => run({ advanced: { steps: 500 } })).toThrow(/Steps/);
    expect(() => run({ advanced: { sampler: 'not_a_real_sampler' } })).toThrow(/Sampler/);
  });
});
