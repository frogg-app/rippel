/**
 * Unit tests for the workflow templates.
 *
 * None of these graphs has been executed end to end against the test ComfyUI
 * box: it has no image checkpoint our SDXL templates can use, and the one video
 * model it has is missing the companion text encoder LTX-Video needs (see the
 * header of txt2vid-ltxv.ts). These tests stand in for that: they check the
 * things a live run would have caught — that the graph is API format and not the
 * UI export, that every link points somewhere real, and that every manifest path
 * lands on an input that actually exists on that node.
 */

import { describe, expect, it } from 'vitest';

import type { GenerationParams, AspectRatio, QualityPreset } from '@comfy/shared';
import { compile, videoFrameCount } from '../compiler/index.js';
import { ValidationError } from '../compiler/errors.js';
import {
  LTXV_FRAME_QUANTUM,
  LTXV_MAX_FRAMES,
  LTXV_MIN_FRAMES,
  LTXV_QUALITY_PRESETS,
  LTXV_RESOLUTIONS,
  LTXV_SAMPLERS,
  QUALITY_PRESETS,
  SDXL_RESOLUTIONS,
  SDXL_SAMPLERS,
  SDXL_SCHEDULERS,
  TEMPLATES,
  capabilitiesFor,
  findTemplate,
  findTemplateById,
  isNodeLink,
  normalizeBaseModel,
  parseInputPath,
  resolveInputPath,
  txt2imgSdxlTemplate,
  IMG2IMG_INIT_IMAGE_NODE_ID,
  img2imgSdxlTemplate,
  withInitImage,
  LTXV_BASE_MODELS,
  txt2vidLtxvManifest,
  txt2vidLtxvTemplate,
  IMG2VID_FIRST_FRAME_NODE_ID,
  img2vidLtxvManifest,
  img2vidLtxvTemplate,
} from './index.js';
import type { ComfyApiGraph, WorkflowTemplate } from './index.js';

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
      expect(output!.class_type).toMatch(
        /^(SaveImage|PreviewImage|SaveWEBM|SaveAnimatedWEBP|VHS_VideoCombine|SaveVideo)$/,
      );
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

// ---------------------------------------------------------------- video

/**
 * The video templates are exercised by the generic per-template block above
 * like any other. What follows is the part that block cannot know about: that
 * a length in seconds becomes the right number of frames, that the video half
 * of `GenerationParams` reaches the nodes that consume it, and that the tables
 * are sized for video rather than inherited from SDXL.
 */

const VIDEO_MODEL_ID = '00000000-0000-4000-8000-00000000ffff';
const VIDEO_JOB_ID = '00000000-0000-4000-8000-00000000fffe';
const LTXV_FILENAME = 'ltx-video-2b-v0.9.1.safetensors';

function videoParams(overrides: Partial<GenerationParams> = {}): GenerationParams {
  return {
    kind: 'txt2vid',
    prompt: 'a paper boat drifting down a rain gutter, shallow depth of field',
    modelId: VIDEO_MODEL_ID,
    quality: 'balanced',
    aspect: '16:9',
    batchSize: 1,
    video: { lengthSeconds: 2, fps: 25, motion: 35 },
    ...overrides,
  };
}

function compileVideo(template: WorkflowTemplate, overrides: Partial<GenerationParams> = {}) {
  return compile({
    params: videoParams({ kind: template.manifest.capability, ...overrides }),
    template,
    modelFilenames: { [VIDEO_MODEL_ID]: LTXV_FILENAME },
    jobId: VIDEO_JOB_ID,
  });
}

describe('derived frame count', () => {
  it('is length times rate, never a field of its own', () => {
    // The whole reason `VideoParams` has no frame count: two seconds at 25 fps
    // is 50 frames, and there is no third number that could disagree.
    for (const [seconds, fps, frames] of [
      [1, 25, 25],
      [4, 8, 33],
      [2, 12, 25],
    ] as const) {
      const params = videoParams({ video: { lengthSeconds: seconds, fps, motion: 0 } });
      // 8n+1 snapping is applied on top; these cases are chosen to land near it.
      const got = videoFrameCount(params, txt2vidLtxvManifest)!;
      expect(got, `${seconds}s @ ${fps}fps`).toBeGreaterThanOrEqual(seconds * fps);
      expect(got - frames, `${seconds}s @ ${fps}fps`).toBeLessThan(LTXV_FRAME_QUANTUM);
    }
  });

  it('snaps up onto the family grid of 8n + 1', () => {
    for (const seconds of [0.4, 0.5, 1, 1.5, 2, 3, 4, 5, 6]) {
      const params = videoParams({ video: { lengthSeconds: seconds, fps: 25, motion: 0 } });
      const frames = videoFrameCount(params, txt2vidLtxvManifest)!;
      expect((frames - 1) % LTXV_FRAME_QUANTUM, `${seconds}s`).toBe(0);
      // Up, never down: a clip a fraction long is unremarkable, one that is
      // short looks truncated.
      expect(frames, `${seconds}s`).toBeGreaterThanOrEqual(seconds * 25);
    }
  });

  it('leaves a request already on the grid exactly where it is', () => {
    // 97 frames is the family's own default length; asking for it must not
    // quietly become 105.
    const params = videoParams({ video: { lengthSeconds: 97, fps: 1, motion: 0 } });
    expect(videoFrameCount(params, txt2vidLtxvManifest)).toBe(97);
  });

  it('does not snap for a family that declares no quantum', () => {
    const anyLength = { ...txt2vidLtxvManifest, frameQuantum: undefined };
    const params = videoParams({ video: { lengthSeconds: 2, fps: 15, motion: 0 } });
    expect(videoFrameCount(params, anyLength)).toBe(30);
  });

  it('is undefined when the request carries no video block at all', () => {
    const still = videoParams();
    delete still.video;
    expect(videoFrameCount(still, txt2vidLtxvManifest)).toBeUndefined();
  });

  it('is checked against the manifest ceiling after snapping, not before', () => {
    // 6.4s at 25fps is 160 frames, which snaps up to exactly the 161 ceiling
    // and is accepted. 6.5s is 163, which snaps to 169 and must be *rejected*
    // rather than clipped back — a clip shorter than the length recorded on the
    // job is the failure this ordering exists to prevent.
    expect(() =>
      compileVideo(txt2vidLtxvTemplate, { video: { lengthSeconds: 6.4, fps: 25, motion: 0 } }),
    ).not.toThrow();
    expect(() =>
      compileVideo(txt2vidLtxvTemplate, { video: { lengthSeconds: 6.5, fps: 25, motion: 0 } }),
    ).toThrow(ValidationError);
  });

  it('refuses a request with no video block on a video template', () => {
    const still = videoParams();
    delete still.video;
    expect(() =>
      compile({
        params: still,
        template: txt2vidLtxvTemplate,
        modelFilenames: { [VIDEO_MODEL_ID]: LTXV_FILENAME },
        jobId: VIDEO_JOB_ID,
      }),
    ).toThrow(/Frames is required/);
  });
});

describe('txt2vid-ltxv specifics', () => {
  const graph = txt2vidLtxvTemplate.graph;

  it('loads the text encoder separately, because an LTXV checkpoint has no CLIP', () => {
    expect(graph['4']!.class_type).toBe('CheckpointLoaderSimple');
    expect(graph['12']!.class_type).toBe('CLIPLoader');
    expect(graph['12']!.inputs['type']).toBe('ltxv');
    // Both encodes take node 12's CLIP, not the checkpoint's — the checkpoint's
    // is null and the graph would fail at execution, not at validation.
    expect(graph['6']!.inputs['clip']).toEqual(['12', 0]);
    expect(graph['7']!.inputs['clip']).toEqual(['12', 0]);
    expect(graph['3']!.inputs['model']).toEqual(['4', 0]);
    expect(graph['8']!.inputs['vae']).toEqual(['4', 2]);
  });

  it('routes both conditionings through LTXVConditioning before the sampler', () => {
    expect(graph['13']!.class_type).toBe('LTXVConditioning');
    expect(graph['13']!.inputs['positive']).toEqual(['6', 0]);
    expect(graph['13']!.inputs['negative']).toEqual(['7', 0]);
    // Outputs 0 and 1, in that order. Crossing them swaps the prompts silently.
    expect(graph['3']!.inputs['positive']).toEqual(['13', 0]);
    expect(graph['3']!.inputs['negative']).toEqual(['13', 1]);
  });

  it('takes its sigmas from LTXVScheduler rather than a scheduler enum', () => {
    expect(graph['3']!.class_type).toBe('SamplerCustom');
    expect(graph['14']!.class_type).toBe('KSamplerSelect');
    expect(graph['15']!.class_type).toBe('LTXVScheduler');
    expect(graph['3']!.inputs['sampler']).toEqual(['14', 0]);
    expect(graph['3']!.inputs['sigmas']).toEqual(['15', 0]);
    expect(graph['3']!.inputs['latent_image']).toEqual(['5', 0]);
    // Steps live on the scheduler; SamplerCustom has no step count at all.
    expect(graph['3']!.inputs).not.toHaveProperty('steps');
    expect(txt2vidLtxvManifest.inputs.find((i) => i.source === 'steps')!.path).toBe(
      '15.inputs.steps',
    );
    // And nothing binds `scheduler`, because there is no scheduler widget.
    expect(txt2vidLtxvManifest.inputs.find((i) => i.source === 'scheduler')).toBeUndefined();
  });

  it('binds the seed to noise_seed, which is what SamplerCustom calls it', () => {
    // KSampler says `seed`; an unknown key in `inputs` is dropped in silence,
    // so the wrong name would pin every clip to the graph literal.
    const seed = txt2vidLtxvManifest.inputs.find((i) => i.source === 'seed')!;
    expect(seed.path).toBe('3.inputs.noise_seed');
    expect(graph['3']!.inputs).toHaveProperty('noise_seed');
  });

  it('gives SamplerCustom every input the node requires', () => {
    expect(Object.keys(graph['3']!.inputs).sort()).toEqual(
      [
        'add_noise',
        'cfg',
        'latent_image',
        'model',
        'negative',
        'noise_seed',
        'positive',
        'sampler',
        'sigmas',
      ].sort(),
    );
  });

  it('writes the video params into the nodes that consume them', () => {
    const { graph: out, resolved } = compileVideo(txt2vidLtxvTemplate, {
      aspect: '16:9',
      quality: 'fast',
      video: { lengthSeconds: 2, fps: 12, motion: 0 },
    });

    // 24 frames snapped up to 25 = 8*3 + 1.
    expect(out['5']!.inputs['length']).toBe(25);
    expect(out['5']!.inputs['width']).toBe(704);
    expect(out['5']!.inputs['height']).toBe(384);
    expect(out['5']!.inputs['batch_size']).toBe(1);
    expect(out['15']!.inputs['steps']).toBe(LTXV_QUALITY_PRESETS.fast.steps);
    expect(out['3']!.inputs['cfg']).toBe(LTXV_QUALITY_PRESETS.fast.cfg);
    expect(out['14']!.inputs['sampler_name']).toBe(LTXV_QUALITY_PRESETS.fast.sampler);
    expect(out['3']!.inputs['noise_seed']).toBe(resolved.seed);
    expect(out['4']!.inputs['ckpt_name']).toBe(LTXV_FILENAME);
    expect(resolved.values.frameCount).toBe(25);
    expect(resolved.values.fps).toBe(12);
  });

  it('sends one frame rate to both the model and the container', () => {
    // Conditioned at one rate and muxed at another is 25 correct frames played
    // at the wrong speed — a bug with no visible symptom in any single frame.
    const { graph: out } = compileVideo(txt2vidLtxvTemplate, {
      video: { lengthSeconds: 1, fps: 16, motion: 0 },
    });
    expect(out['13']!.inputs['frame_rate']).toBe(16);
    expect(out['9']!.inputs['fps']).toBe(16);

    const fpsPaths = txt2vidLtxvManifest.inputs.filter((i) => i.source === 'fps').map((i) => i.path);
    expect(fpsPaths.sort()).toEqual(['13.inputs.frame_rate', '9.inputs.fps']);
  });

  it('saves a real video container under a per-job prefix', () => {
    const { graph: out } = compileVideo(txt2vidLtxvTemplate);
    expect(out['9']!.class_type).toBe('SaveWEBM');
    expect(out['9']!.inputs['filename_prefix']).toBe(`comfy-studio/txt2vid/${VIDEO_JOB_ID}`);
  });

  it('offers no LoRA chain, rather than one that would be ignored', () => {
    // The chain repoints CLIP consumers at the loader tail, and this graph's
    // CLIP comes from a different node than its MODEL. Claiming support would
    // let a request through that silently drops the LoRA.
    expect(txt2vidLtxvManifest.lora).toBeUndefined();
    expect(() =>
      compileVideo(txt2vidLtxvTemplate, { loras: [{ modelId: VIDEO_MODEL_ID, weight: 0.8 }] }),
    ).toThrow(/does not support LoRAs/);
  });
});

describe('img2vid-ltxv specifics', () => {
  const graph = img2vidLtxvTemplate.graph;
  const manifest = img2vidLtxvManifest;

  it('is txt2vid with the empty latent swapped for the first-frame chain', () => {
    for (const id of ['4', '12', '6', '7', '13', '14', '15', '3', '8', '9']) {
      expect(graph[id]!.class_type, id).toBe(txt2vidLtxvTemplate.graph[id]!.class_type);
    }
    expect(graph['5'], 'the empty latent must be gone').toBeUndefined();
    expect(graph['10']!.class_type).toBe('LoadImage');
    expect(graph['17']!.class_type).toBe('LTXVPreprocess');
    expect(graph['18']!.class_type).toBe('LTXVImgToVideo');
  });

  it('feeds the text encodes into LTXVImgToVideo and its outputs onward', () => {
    // LTXVImgToVideo rewrites both conditionings to carry the guide frame and
    // hands back the latent stack too, so it sits *between* the encodes and
    // LTXVConditioning. Wiring 13 straight to 6/7 loses the image silently.
    expect(graph['18']!.inputs['positive']).toEqual(['6', 0]);
    expect(graph['18']!.inputs['negative']).toEqual(['7', 0]);
    expect(graph['18']!.inputs['image']).toEqual(['17', 0]);
    expect(graph['18']!.inputs['vae']).toEqual(['4', 2]);
    expect(graph['13']!.inputs['positive']).toEqual(['18', 0]);
    expect(graph['13']!.inputs['negative']).toEqual(['18', 1]);
    expect(graph['3']!.inputs['latent_image']).toEqual(['18', 2]);
  });

  it('binds motion to the conditioning-frame compression, this family\'s only motion control', () => {
    const motion = manifest.inputs.find((i) => i.source === 'motion');
    expect(motion?.path).toBe('17.inputs.img_compression');
    expect(motion?.constraint).toEqual({ kind: 'int', min: 0, max: 100, step: 1 });

    const { graph: out } = compileVideo(img2vidLtxvTemplate, {
      video: { lengthSeconds: 1, fps: 25, motion: 72 },
    });
    expect(out['17']!.inputs['img_compression']).toBe(72);
  });

  it('rejects a motion value outside the range this family understands', () => {
    // `VideoParams.motion` is documented as 0..255 for SVD-style models; the
    // manifest is what bounds it per family, and the UI reads its slider from
    // the same numbers.
    expect(() =>
      compileVideo(img2vidLtxvTemplate, { video: { lengthSeconds: 1, fps: 25, motion: 200 } }),
    ).toThrow(/Motion must be between 0 and 100/);
  });

  it('does bind width, height and batch, unlike img2img', () => {
    // LTXVImgToVideo resizes the guide frame to the size it is told; the clip's
    // size is a property of the model's buckets, not of the dropped file.
    for (const source of ['width', 'height', 'batchSize'] as const) {
      expect(manifest.inputs.find((i) => i.source === source), source).toBeDefined();
    }
    const { graph: out } = compileVideo(img2vidLtxvTemplate, { aspect: '9:16' });
    expect(out['18']!.inputs['width']).toBe(384);
    expect(out['18']!.inputs['height']).toBe(704);
  });

  it('pins the guide strength at full, and keeps it out of the manifest', () => {
    // "Animate this image" promises the clip starts from that image.
    expect(graph['18']!.inputs['strength']).toBe(1.0);
    for (const input of manifest.inputs) expect(input.path).not.toBe('18.inputs.strength');
  });

  it('leaves the first frame out of the manifest, exactly as img2img does', () => {
    for (const input of manifest.inputs) {
      expect(input.path.startsWith(`${IMG2VID_FIRST_FRAME_NODE_ID}.`)).toBe(false);
    }
    expect(graph[IMG2VID_FIRST_FRAME_NODE_ID]!.class_type).toBe('LoadImage');
  });

  it('takes its first frame through the same transfer img2img uses', () => {
    // The node id is img2img's, so withInitImage's default reaches it: one
    // upload path for every input image in the product, not two.
    expect(IMG2VID_FIRST_FRAME_NODE_ID).toBe(IMG2IMG_INIT_IMAGE_NODE_ID);
    const out = withInitImage(img2vidLtxvTemplate.graph, 'comfy-studio/frame0.png');
    expect(out[IMG2VID_FIRST_FRAME_NODE_ID]!.inputs['image']).toBe('comfy-studio/frame0.png');
    expect(img2vidLtxvTemplate.graph[IMG2VID_FIRST_FRAME_NODE_ID]!.inputs['image']).toBe(
      'example.png',
    );
  });

  it('offers no lastFrame binding, because 0.9.1 cannot interpolate to one', () => {
    // LTXVImgToVideo conditions on a single guide. A control that changed
    // nothing would be worse than no control.
    expect(graph['18']!.inputs).not.toHaveProperty('last_image');
    expect(Object.values(graph).map((n) => n.class_type)).not.toContain('LTXVAddGuide');
  });
});

describe('LTX-Video registry entries', () => {
  it('reports both video capabilities for the family family.ts infers', () => {
    // `ltx-video` is exactly what FAMILIES.ltxVideo records for
    // ltx-video-2b-v0.9.1.safetensors; if this ever disagrees, the model is
    // discovered, shown in the picker, and has no template.
    expect([...capabilitiesFor('ltx-video')].sort()).toEqual(['img2vid', 'txt2vid']);
    expect([...capabilitiesFor('LTXV')].sort()).toEqual(['img2vid', 'txt2vid']);
  });

  it('finds each video template by family, however it is spelled', () => {
    for (const spelling of ['ltx-video', 'LTX-Video', 'ltxv', 'LTXV']) {
      expect(findTemplate('txt2vid', spelling)?.manifest.id, spelling).toBe('txt2vid-ltxv');
      expect(findTemplate('img2vid', spelling)?.manifest.id, spelling).toBe('img2vid-ltxv');
    }
  });

  it('does not offer video for an image family, or images for a video one', () => {
    expect(findTemplate('txt2vid', 'sdxl')).toBeUndefined();
    expect(findTemplate('img2vid', 'sdxl')).toBeUndefined();
    expect(findTemplate('txt2img', 'ltx-video')).toBeUndefined();
    expect(capabilitiesFor('hunyuan-video')).toEqual([]);
  });

  it('lists no two family spellings that normalise to the same key', () => {
    // The registry throws at import time on a collision, so this is a clearer
    // failure than a module that will not load.
    const normalised = LTXV_BASE_MODELS.map(normalizeBaseModel);
    expect(new Set(normalised).size).toBe(normalised.length);
  });
});

describe('LTX-Video resolution table', () => {
  it('covers every AspectRatio', () => {
    expect(Object.keys(LTXV_RESOLUTIONS).sort()).toEqual([...ALL_ASPECTS].sort());
  });

  it.each(ALL_ASPECTS)('%s is a multiple of 32 on both axes', (aspect) => {
    const { width, height } = LTXV_RESOLUTIONS[aspect];
    // LTX-Video's VAE downsamples spatially by 32; anything else is rounded by
    // the node and the clip comes back a different size from the asset row.
    expect(width % 32, 'width').toBe(0);
    expect(height % 32, 'height').toBe(0);
  });

  it.each(ALL_ASPECTS)('%s is a video budget, not an SDXL one', (aspect) => {
    const { width, height } = LTXV_RESOLUTIONS[aspect];
    const megapixels = (width * height) / 1_000_000;
    // The failure this guards against is someone reusing SDXL_RESOLUTIONS: at
    // 1 MP per frame, 97 frames will not decode on the hardware this family
    // exists for.
    expect(megapixels, aspect).toBeLessThan(0.35);
    expect(megapixels, aspect).toBeGreaterThan(0.2);
    expect(LTXV_RESOLUTIONS[aspect]).not.toEqual(SDXL_RESOLUTIONS[aspect]);
  });

  it('orients and mirrors each ratio the way its label reads', () => {
    for (const aspect of ALL_ASPECTS) {
      const { width, height } = LTXV_RESOLUTIONS[aspect];
      const [w, h] = aspect.split(':').map(Number) as [number, number];
      if (w === h) expect(width).toBe(height);
      else if (w > h) expect(width).toBeGreaterThan(height);
      else expect(height).toBeGreaterThan(width);
    }
    expect(LTXV_RESOLUTIONS['3:2'].width).toBe(LTXV_RESOLUTIONS['2:3'].height);
    expect(LTXV_RESOLUTIONS['16:9'].width).toBe(LTXV_RESOLUTIONS['9:16'].height);
  });

  it('stays inside the width/height range both video templates declare', () => {
    for (const template of [txt2vidLtxvTemplate, img2vidLtxvTemplate]) {
      const widthC = template.manifest.inputs.find((i) => i.source === 'width')!.constraint!;
      const heightC = template.manifest.inputs.find((i) => i.source === 'height')!.constraint!;
      if (widthC.kind !== 'int' || heightC.kind !== 'int') throw new Error('expected int bounds');
      for (const aspect of ALL_ASPECTS) {
        const { width, height } = LTXV_RESOLUTIONS[aspect];
        expect(width % widthC.step!, `${template.manifest.id} ${aspect}`).toBe(0);
        expect(width).toBeGreaterThanOrEqual(widthC.min);
        expect(width).toBeLessThanOrEqual(widthC.max);
        expect(height).toBeGreaterThanOrEqual(heightC.min);
        expect(height).toBeLessThanOrEqual(heightC.max);
      }
    }
  });
});

describe('LTX-Video quality preset table', () => {
  it('covers every QualityPreset', () => {
    expect(Object.keys(LTXV_QUALITY_PRESETS).sort()).toEqual([...ALL_QUALITIES].sort());
  });

  it.each(ALL_QUALITIES)('%s is fully specified and offers a sampler we expose', (quality) => {
    const preset = LTXV_QUALITY_PRESETS[quality];
    expect(Number.isInteger(preset.steps)).toBe(true);
    expect(preset.steps).toBeGreaterThan(0);
    expect(LTXV_SAMPLERS as readonly string[]).toContain(preset.sampler);
  });

  it('orders the presets by increasing effort', () => {
    expect(LTXV_QUALITY_PRESETS.fast.steps).toBeLessThan(LTXV_QUALITY_PRESETS.balanced.steps);
    expect(LTXV_QUALITY_PRESETS.balanced.steps).toBeLessThan(LTXV_QUALITY_PRESETS.high.steps);
  });

  it('is a video preset table, not the SDXL one', () => {
    // Running LTX-Video at SDXL's 28 steps and cfg 6.5 gives a saturated,
    // juddering clip; this is the assertion that catches a copy-paste.
    for (const quality of ALL_QUALITIES) {
      expect(LTXV_QUALITY_PRESETS[quality].cfg).toBeLessThan(QUALITY_PRESETS[quality].cfg);
      expect(LTXV_QUALITY_PRESETS[quality].steps).toBeLessThan(QUALITY_PRESETS[quality].steps);
    }
  });

  it('satisfies both video templates\' own step, cfg and sampler constraints', () => {
    for (const template of [txt2vidLtxvTemplate, img2vidLtxvTemplate]) {
      const bySource = new Map(template.manifest.inputs.map((i) => [i.source, i]));
      for (const quality of ALL_QUALITIES) {
        const preset = LTXV_QUALITY_PRESETS[quality];
        const steps = bySource.get('steps')!.constraint!;
        const cfg = bySource.get('guidance')!.constraint!;
        const sampler = bySource.get('sampler')!.constraint!;
        if (steps.kind === 'int') {
          expect(preset.steps).toBeGreaterThanOrEqual(steps.min);
          expect(preset.steps).toBeLessThanOrEqual(steps.max);
        }
        if (cfg.kind === 'float') {
          expect(preset.cfg).toBeGreaterThanOrEqual(cfg.min);
          expect(preset.cfg).toBeLessThanOrEqual(cfg.max);
        }
        if (sampler.kind === 'enum') expect(sampler.values).toContain(preset.sampler);
      }
    }
  });

  it('keeps the frame bounds on the 8n + 1 grid the family samples on', () => {
    expect((LTXV_MIN_FRAMES - 1) % LTXV_FRAME_QUANTUM).toBe(0);
    expect((LTXV_MAX_FRAMES - 1) % LTXV_FRAME_QUANTUM).toBe(0);
    for (const template of [txt2vidLtxvTemplate, img2vidLtxvTemplate]) {
      const frames = template.manifest.inputs.find((i) => i.source === 'frameCount')!.constraint!;
      if (frames.kind !== 'int') throw new Error('expected int bounds');
      expect(frames.min, template.manifest.id).toBe(LTXV_MIN_FRAMES);
      expect(frames.max, template.manifest.id).toBe(LTXV_MAX_FRAMES);
      expect(template.manifest.frameQuantum).toBe(LTXV_FRAME_QUANTUM);
    }
  });
});
