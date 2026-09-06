import { describe, expect, it } from 'vitest';

import { ValidationError, TemplateError } from '../errors.js';
import { applyLoraChain } from '../lora.js';
import { makeGraph } from './fixtures.js';

const spec = { anchorNodeId: '4', modelSlot: 0, clipSlot: 1 } as const;

describe('applyLoraChain', () => {
  it('is a no-op for an empty selection', () => {
    const graph = makeGraph();
    const result = applyLoraChain(graph, spec, []);
    expect(result.graph).toBe(graph);
    expect(result.nodeIds).toEqual([]);
  });

  it('splices one loader and rewires every model/clip consumer', () => {
    const graph = makeGraph();
    const { graph: next, nodeIds } = applyLoraChain(graph, spec, [
      { filename: 'a.safetensors', weight: 0.8 },
    ]);

    expect(nodeIds).toHaveLength(1);
    const id = nodeIds[0]!;
    expect(next[id]!.class_type).toBe('LoraLoader');
    expect(next[id]!.inputs).toMatchObject({
      lora_name: 'a.safetensors',
      strength_model: 0.8,
      strength_clip: 0.8,
      model: ['4', 0],
      clip: ['4', 1],
    });

    // KSampler's MODEL and both text encoders' CLIP now come from the LoRA.
    expect(next['3']!.inputs.model).toEqual([id, 0]);
    expect(next['6']!.inputs.clip).toEqual([id, 1]);
    expect(next['7']!.inputs.clip).toEqual([id, 1]);
    // VAE is not a LoraLoader output, so that link is left alone.
    expect(next['8']!.inputs.vae).toEqual(['4', 2]);
  });

  it('chains multiple LoRAs nose-to-tail with only the last one consumed', () => {
    const graph = makeGraph();
    const { graph: next, nodeIds } = applyLoraChain(graph, spec, [
      { filename: 'a.safetensors', weight: 1 },
      { filename: 'b.safetensors', weight: 0.5 },
      { filename: 'c.safetensors', weight: -0.25 },
    ]);

    const [a, b, c] = nodeIds as [string, string, string];
    expect(next[a]!.inputs.model).toEqual(['4', 0]);
    expect(next[b]!.inputs.model).toEqual([a, 0]);
    expect(next[b]!.inputs.clip).toEqual([a, 1]);
    expect(next[c]!.inputs.model).toEqual([b, 0]);
    expect(next[c]!.inputs.clip).toEqual([b, 1]);

    expect(next['3']!.inputs.model).toEqual([c, 0]);
    expect(next['6']!.inputs.clip).toEqual([c, 1]);

    // Nothing downstream still reads the checkpoint's MODEL or CLIP.
    for (const [id, node] of Object.entries(next)) {
      if (nodeIds.includes(id)) continue;
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value) && value[0] === '4') {
          expect(value[1]).toBe(2); // VAE only
        }
      }
    }
  });

  it('does not mutate the graph it was given', () => {
    const graph = makeGraph();
    const before = structuredClone(graph);
    applyLoraChain(graph, spec, [{ filename: 'a.safetensors', weight: 1 }]);
    expect(graph).toEqual(before);
  });

  it('allocates ids that cannot collide with the template', () => {
    const graph = makeGraph();
    graph['10'] = { class_type: 'PreviewImage', inputs: { images: ['8', 0] } };
    graph['nonnumeric'] = { class_type: 'Note', inputs: {} };

    const { graph: next, nodeIds } = applyLoraChain(graph, spec, [
      { filename: 'a.safetensors', weight: 1 },
      { filename: 'b.safetensors', weight: 1 },
    ]);

    expect(nodeIds).toEqual(['11', '12']);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    for (const id of nodeIds) expect(Object.keys(graph)).not.toContain(id);
    expect(next['10']!.class_type).toBe('PreviewImage');
  });

  it('rejects an out-of-range weight naming the offending entry', () => {
    const graph = makeGraph();
    expect(() =>
      applyLoraChain(graph, spec, [
        { filename: 'a.safetensors', weight: 1 },
        { filename: 'b.safetensors', weight: 99 },
      ]),
    ).toThrow(ValidationError);

    try {
      applyLoraChain(graph, spec, [{ filename: 'a.safetensors', weight: 99 }]);
    } catch (err) {
      expect((err as ValidationError).field).toBe('loras[0].weight');
    }
  });

  it('enforces the manifest LoRA cap', () => {
    const graph = makeGraph();
    const many = Array.from({ length: 3 }, (_, i) => ({ filename: `${i}.safetensors`, weight: 1 }));
    expect(() => applyLoraChain(graph, { ...spec, maxLoras: 2 }, many)).toThrow(/At most 2/);
  });

  it('fails loudly when the anchor node is missing', () => {
    const graph = makeGraph();
    expect(() =>
      applyLoraChain(graph, { ...spec, anchorNodeId: '404' }, [
        { filename: 'a.safetensors', weight: 1 },
      ]),
    ).toThrow(TemplateError);
  });

  it('honours a custom node class', () => {
    const graph = makeGraph();
    const { graph: next, nodeIds } = applyLoraChain(
      graph,
      { ...spec, nodeClass: 'LoraLoaderModelOnly' },
      [{ filename: 'a.safetensors', weight: 1 }],
    );
    expect(next[nodeIds[0]!]!.class_type).toBe('LoraLoaderModelOnly');
  });
});
