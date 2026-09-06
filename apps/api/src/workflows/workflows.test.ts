/**
 * Unit tests for the workflow templates.
 *
 * There is no SDXL checkpoint on the test ComfyUI box (it has only Hunyuan and
 * LTX video models), so these graphs cannot be executed end to end yet. These
 * tests stand in for that: they check the things a live run would have caught —
 * that the graph is API format and not the UI export, that every link points
 * somewhere real, and that every manifest path lands on an input that exists.
 */

import { describe, expect, it } from 'vitest';

import type { AspectRatio, QualityPreset } from '@comfy/shared';
import {
  QUALITY_PRESETS,
  SDXL_RESOLUTIONS,
  SDXL_SAMPLERS,
  SDXL_SCHEDULERS,
  TEMPLATES,
  capabilitiesFor,
  findTemplate,
  findTemplateById,
  isNodeLink,
  parseInputPath,
  resolveInputPath,
  txt2imgSdxlTemplate,
  IMG2IMG_INIT_IMAGE_NODE_ID,
  img2imgSdxlTemplate,
  withInitImage,
} from './index.js';
import type { ComfyApiGraph } from './index.js';

/**
 * Kept in sync by hand with the shared enums. `satisfies` on the arrays plus the
 * `Record<...>` typing of the tables means a new enum member fails to compile
 * here *and* in presets.ts, which is the point of listing them twice.
 */
const ALL_ASPECTS = ['1:1', '3:2', '2:3', '16:9', '9:16'] as const satisfies readonly AspectRatio[];
const ALL_QUALITIES = ['fast', 'balanced', 'high'] as const satisfies readonly QualityPreset[];

describe.each(TEMPLATES.map((t) => [t.manifest.id, t] as const))('template %s', (_id, template) => {
  const graph = template.graph as ComfyApiGraph;
  const manifest = template.manifest;

  describe('is valid ComfyUI API format', () => {
    it('is a flat object keyed by node id, not the UI workflow format', () => {
      // The UI export has these; the API format must not. This is the single
      // most common way to get a graph wrong, so it is asserted first.
      expect(graph).not.toHaveProperty('nodes');
      expect(graph).not.toHaveProperty('links');
      expect(graph).not.toHaveProperty('last_node_id');
      expect(Array.isArray(graph)).toBe(false);
      expect(Object.keys(graph).length).toBeGreaterThan(0);
    });

    it('gives every node a class_type and an inputs object', () => {
      for (const [nodeId, node] of Object.entries(graph)) {
        expect(nodeId, 'node ids must be non-empty strings').not.toBe('');
        expect(typeof node.class_type, `node ${nodeId}`).toBe('string');
        expect(node.class_type.length, `node ${nodeId}`).toBeGreaterThan(0);
        expect(node.inputs, `node ${nodeId}`).toBeTypeOf('object');
        expect(Array.isArray(node.inputs), `node ${nodeId}`).toBe(false);
      }
    });

    it('carries no UI-only keys on nodes (widgets_values, pos, order, mode)', () => {
      for (const [nodeId, node] of Object.entries(graph)) {
        for (const forbidden of ['widgets_values', 'pos', 'order', 'mode', 'type', 'outputs']) {
          expect(node, `node ${nodeId} has UI key ${forbidden}`).not.toHaveProperty(forbidden);
        }
      }
    });

    it('only holds widget literals or [nodeId, index] links as input values', () => {
      for (const [nodeId, node] of Object.entries(graph)) {
        for (const [name, value] of Object.entries(node.inputs)) {
          const where = `${nodeId}.inputs.${name}`;
          if (Array.isArray(value)) {
            expect(isNodeLink(value), `${where} is a malformed link`).toBe(true);
          } else {
            expect(['string', 'number', 'boolean'], where).toContain(typeof value);
          }
        }
      }
    });

    it('resolves every link to a node that exists', () => {
      for (const [nodeId, node] of Object.entries(graph)) {
        for (const [name, value] of Object.entries(node.inputs)) {
          if (!isNodeLink(value)) continue;
          const [targetId, outputIndex] = value;
          expect(Object.keys(graph), `${nodeId}.inputs.${name} -> ${targetId}`).toContain(targetId);
          expect(outputIndex, `${nodeId}.inputs.${name}`).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(outputIndex)).toBe(true);
        }
      }
    });

    it('has no cycles and reaches the output node from the roots', () => {
      // A cycle would hang ComfyUI's executor; an unreachable output node means
      // the job would report success having saved nothing.
      const seen = new Set<string>();
      const stack = new Set<string>();
      const visit = (id: string): void => {
        if (seen.has(id)) return;
        expect(stack.has(id), `cycle through node ${id}`).toBe(false);
        stack.add(id);
        const node = graph[id];
        expect(node, `dangling node id ${id}`).toBeDefined();
        for (const value of Object.values(node!.inputs)) {
          if (isNodeLink(value)) visit(value[0]);
        }
        stack.delete(id);
        seen.add(id);
      };
      visit(manifest.outputNodeId);
      // Every node in the file must be on the path to the output; a stray node
      // is dead weight ComfyUI will still try to execute.
      expect([...seen].sort()).toEqual(Object.keys(graph).sort());
    });
  });

  describe('manifest', () => {
    it('declares the node classes the graph actually uses', () => {
      const used = new Set(Object.values(graph).map((n) => n.class_type));
      expect(new Set(manifest.requiredNodeClasses)).toEqual(used);
    });

    it('names an output node that exists and is an output class', () => {
      const output = graph[manifest.outputNodeId];
      expect(output, `outputNodeId ${manifest.outputNodeId}`).toBeDefined();
      expect(output!.class_type).toMatch(/^(SaveImage|PreviewImage|SaveAnimatedWEBP|VHS_VideoCombine|SaveVideo)$/);
    });

    it('resolves every input path to a real node input', () => {
      for (const input of manifest.inputs) {
        expect(parseInputPath(input.path), `malformed path ${input.path}`).toBeDefined();
        const value = resolveInputPath(graph, input.path);
        expect(value, `${input.path} does not exist in the graph`).toBeDefined();
      }
    });

    it('never binds a user parameter to a link input', () => {
      // Writing a scalar over a link would sever the graph. Only widget values
      // are ever user-facing.
      for (const input of manifest.inputs) {
        const value = resolveInputPath(graph, input.path)!;
        expect(isNodeLink(value), `${input.path} is a link, not a widget`).toBe(false);
      }
    });

    it('binds each path only once', () => {
      const paths = manifest.inputs.map((i) => i.path);
      expect(new Set(paths).size).toBe(paths.length);
    });

    it('has graph defaults that satisfy their own constraints', () => {
      // The hand-authored literals are the fallback for optional inputs, so an
      // out-of-range default is a live bug, not just untidiness.
      for (const input of manifest.inputs) {
        const c = input.constraint;
        if (!c) continue;
        const value = resolveInputPath(graph, input.path)!;
        switch (c.kind) {
          case 'int':
            expect(typeof value, input.path).toBe('number');
            expect(Number.isInteger(value as number), input.path).toBe(true);
            expect(value as number, input.path).toBeGreaterThanOrEqual(c.min);
            expect(value as number, input.path).toBeLessThanOrEqual(c.max);
            break;
          case 'float':
            expect(typeof value, input.path).toBe('number');
            expect(value as number, input.path).toBeGreaterThanOrEqual(c.min);
            expect(value as number, input.path).toBeLessThanOrEqual(c.max);
            break;
          case 'enum':
            expect(c.values, input.path).toContain(value as string);
            break;
          case 'string':
          case 'model':
            expect(typeof value, input.path).toBe('string');
            break;
        }
      }
    });
  });
});

describe('txt2img-sdxl specifics', () => {
  const graph = txt2imgSdxlTemplate.graph;

  it('wires checkpoint -> clip x2 -> sampler -> decode -> save', () => {
    expect(graph['4']!.class_type).toBe('CheckpointLoaderSimple');
    expect(graph['6']!.class_type).toBe('CLIPTextEncode');
    expect(graph['7']!.class_type).toBe('CLIPTextEncode');
    expect(graph['5']!.class_type).toBe('EmptyLatentImage');
    expect(graph['3']!.class_type).toBe('KSampler');
    expect(graph['8']!.class_type).toBe('VAEDecode');
    expect(graph['9']!.class_type).toBe('SaveImage');

    // CheckpointLoaderSimple outputs are ordered MODEL, CLIP, VAE — the indices
    // below are the whole reason a wrong one produces a baffling type error on
    // the backend rather than a clear message.
    expect(graph['6']!.inputs['clip']).toEqual(['4', 1]);
    expect(graph['7']!.inputs['clip']).toEqual(['4', 1]);
    expect(graph['3']!.inputs['model']).toEqual(['4', 0]);
    expect(graph['3']!.inputs['positive']).toEqual(['6', 0]);
    expect(graph['3']!.inputs['negative']).toEqual(['7', 0]);
    expect(graph['3']!.inputs['latent_image']).toEqual(['5', 0]);
    expect(graph['8']!.inputs['samples']).toEqual(['3', 0]);
    expect(graph['8']!.inputs['vae']).toEqual(['4', 2]);
    expect(graph['9']!.inputs['images']).toEqual(['8', 0]);
  });

  it('gives KSampler every input the node requires', () => {
    // Omitting one of these is accepted by our own validation but rejected by
    // ComfyUI with "required input is missing".
    expect(Object.keys(graph['3']!.inputs).sort()).toEqual(
      [
        'cfg',
        'denoise',
        'latent_image',
        'model',
        'negative',
        'positive',
        'sampler_name',
        'scheduler',
        'seed',
        'steps',
      ].sort(),
    );
  });

  it('starts txt2img at full denoise', () => {
    expect(graph['3']!.inputs['denoise']).toBe(1.0);
  });
});

describe('img2img-sdxl specifics', () => {
  const graph = img2imgSdxlTemplate.graph;
  const manifest = img2imgSdxlTemplate.manifest;

  it('is txt2img with the empty latent swapped for LoadImage -> VAEEncode', () => {
    // Everything the two graphs share keeps its node id and its wiring, so a
    // dumped graph from either template reads the same way.
    for (const id of ['4', '6', '7', '3', '8', '9']) {
      expect(graph[id]!.class_type, id).toBe(txt2imgSdxlTemplate.graph[id]!.class_type);
    }
    expect(graph['5'], 'the empty latent must be gone').toBeUndefined();
    expect(graph['10']!.class_type).toBe('LoadImage');
    expect(graph['11']!.class_type).toBe('VAEEncode');

    // The init image is decoded with the checkpoint's own VAE (output 2), and
    // the resulting latent is what the sampler starts from.
    expect(graph['11']!.inputs['pixels']).toEqual(['10', 0]);
    expect(graph['11']!.inputs['vae']).toEqual(['4', 2]);
    expect(graph['3']!.inputs['latent_image']).toEqual(['11', 0]);
  });

  it('binds denoise to the sampler, which is how the influence slider reaches it', () => {
    // compile.ts resolves the `denoise` binding from the init reference's
    // `influence`; this path is the entire wiring between the two.
    const denoise = manifest.inputs.find((i) => i.source === 'denoise');
    expect(denoise?.path).toBe('3.inputs.denoise');
    expect(denoise?.required, 'img2img without an init image is a contradiction').toBe(true);
    // Unlike txt2img, the graph's own default must not be full denoise, or the
    // template silently ignores the source image when something goes wrong.
    expect(graph['3']!.inputs['denoise']).toBeLessThan(1);
  });

  it('binds no size or batch inputs, because the init image decides both', () => {
    for (const source of ['width', 'height', 'batchSize'] as const) {
      expect(manifest.inputs.find((i) => i.source === source), source).toBeUndefined();
    }
  });

  it('leaves the init image out of the manifest entirely', () => {
    // The filename is not a user parameter — it names a file on the backend's
    // disk that only exists after we put it there. See img2img-sdxl.ts.
    for (const input of manifest.inputs) {
      expect(input.path.startsWith(`${IMG2IMG_INIT_IMAGE_NODE_ID}.`)).toBe(false);
    }
    expect(graph[IMG2IMG_INIT_IMAGE_NODE_ID]!.class_type).toBe('LoadImage');
  });
});

describe('withInitImage', () => {
  it('points the LoadImage node at the transferred file without mutating the template', () => {
    // The name is the backend's `subfolder/name`, not a bare filename: files we
    // push land in a subfolder of input/, and that path is what LoadImage
    // resolves. See the verified notes in init-image.ts.
    const out = withInitImage(img2imgSdxlTemplate.graph, 'comfy-studio/abc123.png');
    expect(out[IMG2IMG_INIT_IMAGE_NODE_ID]!.inputs['image']).toBe('comfy-studio/abc123.png');
    // The template is a module-level constant shared by every job.
    expect(img2imgSdxlTemplate.graph[IMG2IMG_INIT_IMAGE_NODE_ID]!.inputs['image']).toBe(
      'example.png',
    );
    // Nothing else moved.
    expect(out['3']).toEqual(img2imgSdxlTemplate.graph['3']);
  });

  it('refuses a graph that has no LoadImage where it expects one', () => {
    expect(() => withInitImage(txt2imgSdxlTemplate.graph, 'x.png')).toThrow(/no init-image node/);
    expect(() => withInitImage(img2imgSdxlTemplate.graph, 'x.png', '3')).toThrow(/not a LoadImage/);
  });
});

describe('registry', () => {
  it('finds the SDXL txt2img template by family, however it is spelled', () => {
    for (const spelling of ['sdxl', 'SDXL', 'SDXL 1.0', 'sdxl-1.0', 'Pony']) {
      expect(findTemplate('txt2img', spelling)?.manifest.id).toBe('txt2img-sdxl');
    }
  });

  it('finds the SDXL img2img template for the same family spellings', () => {
    for (const spelling of ['sdxl', 'SDXL 1.0', 'Illustrious']) {
      expect(findTemplate('img2img', spelling)?.manifest.id).toBe('img2img-sdxl');
    }
  });

  it('returns undefined for an unknown family or a model with none', () => {
    expect(findTemplate('txt2img', 'flux.1')).toBeUndefined();
    expect(findTemplate('img2img', 'flux.1')).toBeUndefined();
    expect(findTemplate('img2vid', 'sdxl')).toBeUndefined();
    expect(findTemplate('txt2img', null)).toBeUndefined();
  });

  it('finds by manifest id', () => {
    expect(findTemplateById('txt2img-sdxl')).toBe(txt2imgSdxlTemplate);
    expect(findTemplateById('nope')).toBeUndefined();
  });

  it('reports capabilities per family', () => {
    expect([...capabilitiesFor('SDXL 1.0')].sort()).toEqual(['img2img', 'txt2img']);
    expect(capabilitiesFor('flux.1')).toEqual([]);
    expect(capabilitiesFor(null)).toEqual([]);
  });

  it('gives every template a unique id', () => {
    const ids = TEMPLATES.map((t) => t.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('resolution table', () => {
  it('covers every AspectRatio', () => {
    expect(Object.keys(SDXL_RESOLUTIONS).sort()).toEqual([...ALL_ASPECTS].sort());
  });

  it.each(ALL_ASPECTS)('%s is an SDXL-native bucket', (aspect) => {
    const { width, height } = SDXL_RESOLUTIONS[aspect];
    expect(width % 64, 'width must be a multiple of 64').toBe(0);
    expect(height % 64, 'height must be a multiple of 64').toBe(0);
    // ~1 megapixel is what SDXL was trained on; drifting far from it is the
    // cause of the duplicated-subject failure mode.
    const megapixels = (width * height) / 1_000_000;
    expect(megapixels).toBeGreaterThan(0.9);
    expect(megapixels).toBeLessThan(1.15);
  });

  it('orients each ratio the way its label reads', () => {
    for (const aspect of ALL_ASPECTS) {
      const { width, height } = SDXL_RESOLUTIONS[aspect];
      const [w, h] = aspect.split(':').map(Number) as [number, number];
      if (w === h) expect(width).toBe(height);
      else if (w > h) expect(width).toBeGreaterThan(height);
      else expect(height).toBeGreaterThan(width);
    }
  });

  it('mirrors each landscape bucket as its portrait counterpart', () => {
    expect(SDXL_RESOLUTIONS['3:2'].width).toBe(SDXL_RESOLUTIONS['2:3'].height);
    expect(SDXL_RESOLUTIONS['3:2'].height).toBe(SDXL_RESOLUTIONS['2:3'].width);
    expect(SDXL_RESOLUTIONS['16:9'].width).toBe(SDXL_RESOLUTIONS['9:16'].height);
    expect(SDXL_RESOLUTIONS['16:9'].height).toBe(SDXL_RESOLUTIONS['9:16'].width);
  });

  it('stays inside the width/height range the template declares', () => {
    const inputs = txt2imgSdxlTemplate.manifest.inputs;
    const widthC = inputs.find((i) => i.source === 'width')!.constraint!;
    const heightC = inputs.find((i) => i.source === 'height')!.constraint!;
    expect(widthC.kind).toBe('int');
    expect(heightC.kind).toBe('int');
    if (widthC.kind !== 'int' || heightC.kind !== 'int') return;
    for (const aspect of ALL_ASPECTS) {
      const { width, height } = SDXL_RESOLUTIONS[aspect];
      expect(width).toBeGreaterThanOrEqual(widthC.min);
      expect(width).toBeLessThanOrEqual(widthC.max);
      expect(height).toBeGreaterThanOrEqual(heightC.min);
      expect(height).toBeLessThanOrEqual(heightC.max);
    }
  });
});

describe('quality preset table', () => {
  it('covers every QualityPreset', () => {
    expect(Object.keys(QUALITY_PRESETS).sort()).toEqual([...ALL_QUALITIES].sort());
  });

  it.each(ALL_QUALITIES)('%s is fully specified and in range', (quality) => {
    const preset = QUALITY_PRESETS[quality];
    expect(Number.isInteger(preset.steps)).toBe(true);
    expect(preset.steps).toBeGreaterThan(0);
    expect(preset.cfg).toBeGreaterThanOrEqual(1);
    // Only samplers and schedulers we actually offer, or the Advanced drawer
    // would open showing a value it cannot re-select.
    expect(SDXL_SAMPLERS as readonly string[]).toContain(preset.sampler);
    expect(SDXL_SCHEDULERS as readonly string[]).toContain(preset.scheduler);
  });

  it('orders the presets by increasing effort', () => {
    expect(QUALITY_PRESETS.fast.steps).toBeLessThan(QUALITY_PRESETS.balanced.steps);
    expect(QUALITY_PRESETS.balanced.steps).toBeLessThan(QUALITY_PRESETS.high.steps);
  });

  it('satisfies the template constraints for steps, cfg, sampler and scheduler', () => {
    const inputs = txt2imgSdxlTemplate.manifest.inputs;
    const bySource = new Map(inputs.map((i) => [i.source, i]));
    for (const quality of ALL_QUALITIES) {
      const preset = QUALITY_PRESETS[quality];
      const steps = bySource.get('steps')!.constraint!;
      const cfg = bySource.get('guidance')!.constraint!;
      if (steps.kind === 'int') {
        expect(preset.steps).toBeGreaterThanOrEqual(steps.min);
        expect(preset.steps).toBeLessThanOrEqual(steps.max);
      }
      if (cfg.kind === 'float') {
        expect(preset.cfg).toBeGreaterThanOrEqual(cfg.min);
        expect(preset.cfg).toBeLessThanOrEqual(cfg.max);
      }
      const sampler = bySource.get('sampler')!.constraint!;
      const scheduler = bySource.get('scheduler')!.constraint!;
      if (sampler.kind === 'enum') expect(sampler.values).toContain(preset.sampler);
      if (scheduler.kind === 'enum') expect(scheduler.values).toContain(preset.scheduler);
    }
  });
});

describe('path parsing', () => {
  it('accepts only <nodeId>.inputs.<name>', () => {
    expect(parseInputPath('6.inputs.text')).toEqual({ nodeId: '6', inputName: 'text' });
    expect(parseInputPath('3.inputs.sampler_name')).toEqual({
      nodeId: '3',
      inputName: 'sampler_name',
    });
  });

  it('rejects anything that could reach outside a node input', () => {
    for (const bad of [
      '6.class_type',
      '6.inputs',
      '6.inputs.text.extra',
      'inputs.text',
      '$..text',
      '6.inputs.',
      '',
    ]) {
      expect(parseInputPath(bad), bad).toBeUndefined();
    }
  });

  it('does not resolve inherited object properties', () => {
    // `constructor` and `toString` exist on every object; a path naming one must
    // not read back a function as if it were a widget value.
    expect(resolveInputPath(txt2imgSdxlTemplate.graph, '6.inputs.constructor')).toBeUndefined();
    expect(resolveInputPath(txt2imgSdxlTemplate.graph, '6.inputs.toString')).toBeUndefined();
  });
});
