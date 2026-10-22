import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertWorkflow, type ConversionSpecs } from './convert.js';

const specs: ConversionSpecs = {
  Sampler: { input: { required: { model: ['MODEL'], seed: ['INT', { default: 0 }], steps: ['INT', { default: 20 }] } } },
  Model: { input: { required: { filename: [['model.safetensors']] } }, output: ['MODEL'] },
  Text: { input: { required: { text: ['STRING', { default: '' }] } }, output: ['STRING'] },
  Save: { input: { required: { text: ['STRING', { forceInput: true }] } }, output_node: true },
};

describe('unmodified official library files against captured ComfyUI 0.34.0 specs', () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
  const captured = read('object-info') as ConversionSpecs;
  for (const name of ['image_sdxl_simple', 'ltxv_image_to_video', 'hunyuan_video_text_to_video', 'video_wan2_2_5B_ti2v', 'video_wan2_2_14B_i2v']) {
    it(name, () => {
      const workflow = read(name);
      const before = JSON.stringify(workflow);
      const result = convertWorkflow(workflow, captured);
      expect(result.issues).toEqual([]);
      expect(result.missingNodes).toEqual([]);
      expect(Object.keys(result.graph).length).toBeGreaterThan(5);
      expect(JSON.stringify(workflow)).toBe(before);
      for (const node of Object.values(result.graph)) {
        expect(captured[node.class_type]).toBeDefined();
      }
      if (name === 'video_wan2_2_14B_i2v') {
        expect(result.graph['129_98']!.inputs.width).toBe(640);
        expect(result.graph['129_163']!.inputs['values.a']).toEqual(['129_161', 0]);
        expect(result.graph['108']!.inputs.video).toEqual(['129_94', 0]);
        expect(result.graph['108']!.inputs['format.codec']).toBe('auto');
      }
      if (name === 'video_wan2_2_5B_ti2v') {
        // The official file starts in text-to-video mode: LoadImage is bypassed.
        expect(result.graph['55']!.inputs.start_image).toBeUndefined();
        expect(result.graph['3']!.inputs.steps).toBe(20);
      }
    });
  }
});

describe('editor conversion', () => {
  it('maps widget order including seed behavior and preserves model links', () => {
    const result = convertWorkflow({ nodes: [
      { id: 1, type: 'Model', widgets_values: ['model.safetensors'] },
      { id: 2, type: 'Sampler', widgets_values: [123, 'randomize', 12], inputs: [{ name: 'model', type: 'MODEL', link: 5 }] },
      { id: 3, type: 'MarkdownNote', widgets_values: ['Ignore me'] },
    ], links: [[5, 1, 0, 2, 0, 'MODEL']] }, specs);
    expect(result.issues).toEqual([]);
    expect(result.graph['2']!.inputs).toEqual({ model: ['1', 0], seed: 123, steps: 12 });
    expect(result.graph['3']).toBeUndefined();
  });

  it('reports extra widgets and missing nodes rather than guessing names', () => {
    const result = convertWorkflow({ nodes: [
      { id: 1, type: 'Text', widgets_values: ['prompt', 'unmapped'] },
      { id: 2, type: 'UninstalledCustomNode' },
    ] }, specs);
    expect(result.issues).toEqual(['1: 1 unmapped widget value(s).']);
    expect(result.missingNodes).toEqual(['UninstalledCustomNode']);
  });

  it('resolves primitives, reroutes and bypassed nodes without emitting them', () => {
    const result = convertWorkflow({ nodes: [
      { id: 1, type: 'PrimitiveNode', widgets_values: ['hello'] },
      { id: 2, type: 'Reroute', inputs: [{ name: '', type: 'STRING', link: 1 }], outputs: [{ type: 'STRING' }] },
      { id: 3, type: 'Pass', mode: 4, inputs: [{ name: 'text', type: 'STRING', link: 2 }], outputs: [{ type: 'STRING' }] },
      { id: 4, type: 'Save', inputs: [{ name: 'text', type: 'STRING', link: 3 }] },
    ], links: [[1, 1, 0, 2, 0, 'STRING'], [2, 2, 0, 3, 0, 'STRING'], [3, 3, 0, 4, 0, 'STRING']] }, specs);
    expect(result.issues).toEqual([]);
    expect(result.graph).toEqual({ '4': { class_type: 'Save', inputs: { text: 'hello' } } });
  });

  it('reports missing links and required inputs fed by muted nodes', () => {
    const result = convertWorkflow({ nodes: [
      { id: 1, type: 'Text', mode: 2, widgets_values: ['muted'] },
      { id: 2, type: 'Save', inputs: [{ name: 'text', link: 1 }] },
      { id: 3, type: 'Save', inputs: [{ name: 'text', link: 99 }] },
    ], links: [[1, 1, 0, 2, 0, 'STRING']] }, specs);
    expect(result.issues).toContain('2.text: required input has no value.');
    expect(result.issues).toContain('3.text: missing link 99.');
  });

  it('replaces a fixed switch with its branch and drops what no output reads', () => {
    const result = convertWorkflow({ nodes: [
      { id: 1, type: 'Text', widgets_values: ['off'] }, { id: 2, type: 'Text', widgets_values: ['on'] },
      { id: 3, type: 'PrimitiveBoolean', widgets_values: [false] },
      { id: 4, type: 'ComfySwitchNode', inputs: [{ name: 'switch', link: 1 }, { name: 'on_false', link: 2 }, { name: 'on_true', link: 3 }] },
      { id: 5, type: 'Save', inputs: [{ name: 'text', link: 4 }] },
      { id: 6, type: 'Text', widgets_values: [], inputs: [{ name: 'text', link: null }] },
    ], links: [[1, 3, 0, 4, 0, 'BOOLEAN'], [2, 1, 0, 4, 1, '*'], [3, 2, 0, 4, 2, '*'], [4, 4, 0, 5, 0, '*']] }, { ...specs,
      PrimitiveBoolean: { input: { required: { value: ['BOOLEAN', {}] } }, output: ['BOOLEAN'] },
      ComfySwitchNode: { input: { required: { switch: ['BOOLEAN', {}] }, optional: { on_false: ['*', {}], on_true: ['*', {}] } }, output: ['*'] },
    });
    expect(result.graph['5']!.inputs.text).toEqual(['1', 0]);
    expect(Object.keys(result.graph).sort()).toEqual(['1', '5']);
    expect(result.issues).toEqual([]);
  });

  it('flattens two instances independently and transfers exposed widgets', () => {
    const result = convertWorkflow({ nodes: [
      { id: 10, type: 'sub', widgets_values: ['first'] },
      { id: 20, type: 'sub', widgets_values: ['second'] },
      { id: 30, type: 'Save', inputs: [{ name: 'text', link: 3 }] },
    ], links: [[3, 20, 0, 30, 0, 'STRING']], definitions: { subgraphs: [{
      id: 'sub', inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: [{ name: 'text', type: 'STRING' }],
      nodes: [{ id: 1, type: 'Text', widgets_values: ['old'], inputs: [{ name: 'text', link: 1 }] }],
      links: [{ id: 1, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 0 },
        { id: 2, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0 }],
    }] } }, specs);
    expect(result.issues).toEqual([]);
    expect(result.graph['20_1']!.inputs.text).toBe('second');
    // Nothing reads the first instance, so ComfyUI would not run it either.
    expect(result.graph['10_1']).toBeUndefined();
    expect(result.graph['30']!.inputs.text).toEqual(['20_1', 0]);
  });

  it('rejects cycles and duplicate ids', () => {
    expect(() => convertWorkflow({ nodes: [
      { id: 1, type: 'Save', inputs: [{ name: 'text', link: 1 }] },
    ], links: [[1, 1, 0, 1, 0, 'STRING']] }, specs)).toThrow('Cyclic');
    expect(() => convertWorkflow({ nodes: [{ id: 1, type: 'Text' }, { id: 1, type: 'Text' }] }, specs)).toThrow('Duplicate');
  });
});
