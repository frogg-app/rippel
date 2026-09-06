import type { GenerationParams } from '@comfy/shared';
import { describe, expect, it } from 'vitest';

import { compile, dimensionsFor } from '../compile.js';
import { TemplateError, ValidationError } from '../errors.js';
import {
  manifest,
  CHECKPOINT_ID,
  LORA_A_ID,
  LORA_B_ID,
  makeTemplate,
  modelFilenames,
} from './fixtures.js';

const JOB_ID = '00000000-0000-4000-8000-0000000000f1';

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
  return compile({ params: params(overrides), template: makeTemplate(), modelFilenames, jobId: JOB_ID });
}

describe('dimensionsFor', () => {
  it('reads the size straight out of the manifest table', () => {
    expect(dimensionsFor('1:1', manifest)).toEqual({ width: 1024, height: 1024 });
    expect(dimensionsFor('16:9', manifest)).toEqual({ width: 1344, height: 768 });
    expect(dimensionsFor('9:16', manifest)).toEqual({ width: 768, height: 1344 });
  });

  it('returns multiples of 64 for every ratio the family supports', () => {
    for (const aspect of ['1:1', '3:2', '2:3', '16:9', '9:16'] as const) {
      const { width, height } = dimensionsFor(aspect, manifest);
      expect(width % 64).toBe(0);
      expect(height % 64).toBe(0);
    }
  });

  it('rejects a ratio the family has no bucket for', () => {
    const narrow = { ...manifest, resolutions: { '1:1': { width: 1024, height: 1024 } } };
    expect(() => dimensionsFor('16:9', narrow as typeof manifest)).toThrow(/does not support/);
  });
});

describe('compile', () => {
  it('substitutes every bound value into the graph', () => {
    const { graph, resolved } = run({ negativePrompt: 'blurry', aspect: '16:9', batchSize: 2 });

    expect(graph['6']!.inputs.text).toBe('a lighthouse in a storm');
    expect(graph['7']!.inputs.text).toBe('blurry');
    expect(graph['4']!.inputs.ckpt_name).toBe(modelFilenames[CHECKPOINT_ID]);
    expect(graph['5']!.inputs).toMatchObject({ width: 1344, height: 768, batch_size: 2 });
    expect(graph['3']!.inputs).toMatchObject({
      steps: 28,
      cfg: 7,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      seed: resolved.seed,
    });
  });

  it('never mutates the template', () => {
    const template = makeTemplate();
    const before = structuredClone(template.graph);

    compile({
      params: params({ prompt: 'x', loras: [{ modelId: LORA_A_ID, weight: 1 }] }),
      template,
      modelFilenames,
    });
    compile({ params: params({ prompt: 'y', aspect: '9:16' }), template, modelFilenames });

    expect(template.graph).toEqual(before);
    expect(template.graph['6']!.inputs.text).toBe('placeholder positive');
    expect(Object.keys(template.graph)).toHaveLength(Object.keys(before).length);
  });

  it('compiles the same template twice without cross-contamination', () => {
    const template = makeTemplate();
    const a = compile({ params: params({ prompt: 'first' }), template, modelFilenames });
    const b = compile({ params: params({ prompt: 'second' }), template, modelFilenames });
    expect(a.graph['6']!.inputs.text).toBe('first');
    expect(b.graph['6']!.inputs.text).toBe('second');
  });

  it('applies quality-preset defaults, overridden by the advanced drawer', () => {
    expect(run({ quality: 'fast' }).graph['3']!.inputs.steps).toBe(12);
    expect(run({ quality: 'high' }).graph['3']!.inputs.steps).toBe(45);

    const custom = run({ quality: 'fast', advanced: { steps: 33, guidance: 4.5, sampler: 'ddim' } });
    expect(custom.graph['3']!.inputs).toMatchObject({
      steps: 33,
      cfg: 4.5,
      sampler_name: 'ddim',
      scheduler: 'normal', // still from the preset
    });
  });

  it('leaves the template value in place for an unsupplied optional input', () => {
    // No `init` reference, so denoise is not resolvable — the template's 1 stands.
    expect(run().graph['3']!.inputs.denoise).toBe(1);
  });

  it('uses an init reference influence as denoise', () => {
    const { graph } = run({
      references: [
        { source: { from: 'upload', uploadId: 'u1' }, role: 'init', influence: 0.45 },
        { source: { from: 'upload', uploadId: 'u2' }, role: 'style', influence: 0.9 },
      ],
    });
    expect(graph['3']!.inputs.denoise).toBe(0.45);
  });

  it('returns the concrete seed so the job row can re-run it', () => {
    const { resolved, graph } = run();
    expect(Number.isSafeInteger(resolved.seed)).toBe(true);
    expect(graph['3']!.inputs.seed).toBe(resolved.seed);

    const rerun = run({ advanced: { seed: resolved.seed } });
    expect(rerun.resolved.seed).toBe(resolved.seed);
    expect(rerun.graph['3']!.inputs.seed).toBe(resolved.seed);
  });

  it('draws a fresh seed for a null seed', () => {
    const first = run({ advanced: { seed: null } }).resolved.seed;
    const second = run({ advanced: { seed: null } }).resolved.seed;
    expect(first).not.toBe(second);
  });

  it('reports everything it resolved', () => {
    const { resolved, substitutions } = run({ aspect: '2:3', loras: [{ modelId: LORA_A_ID, weight: 0.6 }] });
    expect(resolved).toMatchObject({
      templateId: 'txt2img-sdxl',
      checkpoint: modelFilenames[CHECKPOINT_ID],
      width: 832,
      height: 1216,
      loras: [{ filename: modelFilenames[LORA_A_ID], weight: 0.6 }],
    });
    expect(resolved.values.sampler).toBe('dpmpp_2m');
    expect(resolved.loraNodeIds).toHaveLength(1);
    expect(substitutions.map((s) => s.path)).toContain('3.inputs.steps');
  });

  // -------------------------------------------------------------- validation

  it('rejects out-of-range steps and guidance, naming the field', () => {
    expect(() => run({ advanced: { steps: 500 } })).toThrow(/Steps must be between 1 and 150/);
    expect(() => run({ advanced: { steps: 12.5 } })).toThrow(/whole number/);
    expect(() => run({ advanced: { guidance: -1 } })).toThrow(ValidationError);
    try {
      run({ advanced: { guidance: 99 } });
    } catch (err) {
      expect((err as ValidationError).field).toBe('guidance');
    }
  });

  it('rejects an unknown sampler and scheduler', () => {
    expect(() => run({ advanced: { sampler: 'not_a_sampler' } })).toThrow(
      /Sampler must be one of/,
    );
    expect(() => run({ advanced: { scheduler: 'nope' } })).toThrow(/Scheduler must be one of/);
  });

  it('rejects an empty prompt and an absurdly long one', () => {
    expect(() => run({ prompt: '   ' })).toThrow(/Prompt is required/);
    expect(() => run({ prompt: 'x'.repeat(2001) })).toThrow(/at most 2000 characters/);
    // The negative prompt is allowed to be empty.
    expect(() => run({ negativePrompt: '' })).not.toThrow();
  });

  it('rejects a bad batch size', () => {
    expect(() => run({ batchSize: 0 })).toThrow(/batchSize/);
    expect(() => run({ batchSize: 1.5 })).toThrow(/batchSize/);
    expect(() => run({ batchSize: 99 })).toThrow(/between 1 and 8/);
  });

  it('rejects a model the backend does not have', () => {
    expect(() => run({ modelId: 'missing-id' })).toThrow(/not available/);
    expect(() => run({ loras: [{ modelId: 'missing-id', weight: 1 }] })).toThrow(ValidationError);
  });

  it('does not write anything when validation fails', () => {
    const template = makeTemplate();
    const before = structuredClone(template.graph);
    expect(() =>
      compile({ params: params({ advanced: { steps: 9999 } }), template, modelFilenames }),
    ).toThrow(ValidationError);
    expect(template.graph).toEqual(before);
  });

  it('refuses a template for a different job kind', () => {
    expect(() => run({ kind: 'img2img' })).toThrow(TemplateError);
  });

  it('refuses LoRAs on a template that does not declare a chain', () => {
    const template = makeTemplate();
    const noLora = { manifest: { ...template.manifest, lora: undefined }, graph: template.graph };
    expect(() =>
      compile({
        params: params({ loras: [{ modelId: LORA_A_ID, weight: 1 }] }),
        template: noLora,
        modelFilenames,
      }),
    ).toThrow(/does not support LoRAs/);
  });

  it('errors on a manifest input whose path is gone', () => {
    const template = makeTemplate();
    const broken = {
      manifest: {
        ...template.manifest,
        inputs: [
          ...template.manifest.inputs,
          {
            path: '3.inputs.gone',
            source: 'steps',
            label: 'Steps',
            constraint: { kind: 'int', min: 1, max: 2 },
            required: true,
          },
        ],
      },
      graph: template.graph,
    } as typeof template;
    expect(() =>
      compile({ params: params({ advanced: { steps: 1 } }), template: broken, modelFilenames, jobId: JOB_ID }),
    ).toThrow(
      TemplateError,
    );
  });

  // -------------------------------------------------------------- loras

  it('splices LoRAs into the compiled graph and rewires it', () => {
    const { graph, resolved } = run({
      loras: [
        { modelId: LORA_A_ID, weight: 0.7 },
        { modelId: LORA_B_ID, weight: 0.3 },
      ],
    });

    const [a, b] = resolved.loraNodeIds as [string, string];
    expect(graph[a]!.inputs.lora_name).toBe(modelFilenames[LORA_A_ID]);
    expect(graph[b]!.inputs.lora_name).toBe(modelFilenames[LORA_B_ID]);
    expect(graph[b]!.inputs.model).toEqual([a, 0]);
    expect(graph['3']!.inputs.model).toEqual([b, 0]);
    expect(graph['6']!.inputs.clip).toEqual([b, 1]);
    // Substituted values survive the splice.
    expect(graph['6']!.inputs.text).toBe('a lighthouse in a storm');
  });

  it('produces a graph with no dangling links', () => {
    const { graph } = run({ loras: [{ modelId: LORA_A_ID, weight: 1 }] });
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value) && typeof value[0] === 'string') {
          expect(Object.keys(graph)).toContain(value[0]);
        }
      }
    }
  });
});
