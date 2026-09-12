/**
 * The library reader and converter, against the one real library file we hold.
 *
 * `video_wan2_2_5B_ti2v` was fetched from ComfyUI 0.35.0 and saved untouched.
 * The hand-written `img2vid-wan22-ti2v-5b` graph was built from that same file
 * and checked against the live backend's `/object_info`, which makes it the
 * answer key: if the converter and the hand-made graph disagree about a node, an
 * input name or a wire, one of them is wrong and it is not likely to be the one
 * a person read line by line.
 *
 * The synthetic graphs further down exercise branches the real file does not
 * have. They hold this code's logic to what its header claims and say nothing
 * about whether ComfyUI agrees.
 */

import { describe, expect, it } from 'vitest';
import raw from '../../models/__fixtures__/library-template-wan22-5b.json' with { type: 'json' };
import { img2vidWan22Ti2v5bGraph, img2vidWan22Ti2v5bManifest } from '../img2vid-wan22-ti2v-5b.js';
import { capturedNodeSpecs, describeProblems, validateGraph } from '../validate-graph.js';
import type { ComfyApiGraph } from '../types.js';
import { isNodeLink } from '../paths.js';
import { convertLibraryWorkflow, nodeSpecsFromObjectInfo } from './convert.js';
import {
  LibraryFormatError,
  isTrustedModelUrl,
  libraryModelsOf,
  parseLibraryTemplate,
} from './litegraph.js';

const template = parseLibraryTemplate(raw);
/**
 * The captured specs, plus the one class the Wan graph uses that the capture
 * missed. `CLIPTextEncode` is not in object-info.json. Its two input names are
 * taken from the hand-written graph, whose header records reading them from the
 * live backend, and it has a single widget, so the declaration order the
 * converter depends on cannot be got wrong. The right fix is a fresh capture
 * (tools/capture-object-info.mjs) the next time the backend is up.
 */
const specs = {
  ...capturedNodeSpecs(),
  CLIPTextEncode: { required: { text: { type: 'STRING' }, clip: { type: 'CLIP' } } },
};

/** The library numbers its LoadImage 56; the hand-made graph needs it at 10. */
function renumber(graph: ComfyApiGraph, from: string, to: string): ComfyApiGraph {
  const out: Record<string, (typeof graph)[string]> = {};
  for (const [id, node] of Object.entries(graph)) {
    const inputs = Object.fromEntries(
      Object.entries(node.inputs).map(([name, value]) =>
        isNodeLink(value) && String(value[0]) === from ? [name, [to, value[1]] as const] : [name, value],
      ),
    );
    out[id === from ? to : id] = { ...node, inputs };
  }
  return out;
}

/** Class, input names and wiring per node — everything but the literal values. */
function shape(graph: ComfyApiGraph) {
  return Object.fromEntries(
    Object.entries(graph).map(([id, node]) => [
      id,
      {
        class_type: node.class_type,
        inputs: Object.fromEntries(
          Object.entries(node.inputs).map(([name, value]) => [
            name,
            isNodeLink(value) ? `link:${String(value[0])}.${value[1]}` : 'value',
          ]),
        ),
      },
    ]),
  );
}

describe('what a library workflow needs', () => {
  it('lists the three Wan 5B files with their folders and URLs', () => {
    // The whole of "what do I download" for this workflow, with no converter,
    // no backend and no install catalogue.
    const models = libraryModelsOf(template);
    expect(models.map((m) => `${m.folder}/${m.filename}`)).toEqual([
      'diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
      'text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      'vae/wan2.2_vae.safetensors',
    ]);
    expect(models.every((m) => m.trustedSource && m.url.startsWith('https://huggingface.co/'))).toBe(true);
    expect(models.every((m) => !m.onlyOnInactiveNodes)).toBe(true);
  });

  it('agrees with the hand-written manifest about which files those are', () => {
    // If the library and our requirements named different builds, a person
    // following the library's links would install files our graph does not load.
    const names = libraryModelsOf(template).map((m) => m.filename);
    const preferred = (img2vidWan22Ti2v5bManifest.requires ?? []).flatMap((r) => r.preferred ?? []);
    const checkpoint = img2vidWan22Ti2v5bGraph['37']!.inputs.unet_name;
    expect(new Set(names)).toEqual(new Set([checkpoint, ...preferred]));
  });

  it('keeps the Wan 2.1 VAE out of a URL that says 2.2', () => {
    const vae = libraryModelsOf(template).find((m) => m.folder === 'vae')!;
    expect(vae.url).toMatch(/wan2\.2_vae\.safetensors$/);
  });

  it('trusts only HTTPS from Hugging Face or Civitai', () => {
    expect(isTrustedModelUrl('https://huggingface.co/a/b/resolve/main/c.safetensors')).toBe(true);
    expect(isTrustedModelUrl('https://civitai.com/api/download/models/1')).toBe(true);
    expect(isTrustedModelUrl('http://huggingface.co/a.safetensors')).toBe(false);
    expect(isTrustedModelUrl('https://huggingface.co.evil.example/a.safetensors')).toBe(false);
    expect(isTrustedModelUrl('not a url')).toBe(false);
  });

  it('refuses an API-format graph by saying what it is not', () => {
    // The likeliest wrong file: one of our own graphs/*.api.json.
    expect(() => parseLibraryTemplate(img2vidWan22Ti2v5bGraph)).toThrow(LibraryFormatError);
  });
});

describe('converting the real Wan 5B file', () => {
  it('as shipped: text-to-video, with the bypassed image loader left out and reported', () => {
    const result = convertLibraryWorkflow(template, specs);
    expect(result.problems).toEqual([]);
    expect(result.inactive).toEqual([{ nodeId: '56', nodeClass: 'LoadImage' }]);
    expect(result.graph['56']).toBeUndefined();
    expect(result.graph['59']).toBeUndefined(); // the MarkdownNote
    // start_image is optional, so dropping its wire is valid, not a problem.
    expect(result.graph['55']!.inputs.start_image).toBeUndefined();
  });

  it('with the image loader switched on, reproduces the hand-written graph node for node', () => {
    const result = convertLibraryWorkflow(template, specs, { activate: ['56'] });
    expect(result.problems).toEqual([]);
    const converted = renumber(result.graph, '56', '10');
    expect(shape(converted)).toEqual(shape(img2vidWan22Ti2v5bGraph));
  });

  it('names every widget value correctly, including after the seed control value', () => {
    // The shift bug: miss the "randomize" after the seed and steps becomes 5,
    // cfg becomes "uni_pc". Every field is asserted so a shift cannot hide.
    const { graph } = convertLibraryWorkflow(template, specs, { activate: ['56'] });
    expect(graph['3']!.inputs).toMatchObject({
      seed: 898471028164125,
      steps: 20,
      cfg: 5,
      sampler_name: 'uni_pc',
      scheduler: 'simple',
      denoise: 1,
    });
    expect(graph['55']!.inputs).toMatchObject({ width: 1280, height: 704, length: 121, batch_size: 1 });
    expect(graph['57']!.inputs).toMatchObject({ fps: 24 });
    expect(graph['58']!.inputs).toMatchObject({ filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' });
    expect(graph['38']!.inputs).toMatchObject({
      clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      type: 'wan',
      device: 'default',
    });
    expect(graph['48']!.inputs).toMatchObject({ shift: 8 });
    // LoadImage's trailing upload-widget value is not an input and is not sent.
    expect(graph['56']!.inputs).toEqual({ image: 'example.png' });
  });

  it('passes the offline node-spec validator', () => {
    const { graph } = convertLibraryWorkflow(template, specs, { activate: ['56'] });
    const problems = validateGraph(graph);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it('refuses to name the widgets of a class it has no spec for', () => {
    const { KSampler: _dropped, ...partial } = specs;
    const result = convertLibraryWorkflow(template, partial);
    expect(result.problems.map((p) => p.nodeId)).toEqual(['3']);
    expect(result.problems[0]!.message).toMatch(/No node spec for KSampler/);
  });
});

// ------------------------------------------------------------ synthetic graphs

const PASS_SPECS = {
  Source: { required: { value: { type: 'INT', min: 0, max: 10 } } },
  Sink: { required: { image: { type: 'IMAGE' }, strength: { type: 'FLOAT', min: 0, max: 1 } } },
  Filter: { required: { image: { type: 'IMAGE' } } },
};

function file(nodes: unknown[], links: unknown[], extra: Record<string, unknown> = {}) {
  return parseLibraryTemplate({ nodes, links, ...extra });
}

describe('converter branches the real file does not exercise', () => {
  it('follows a Reroute to the node behind it', () => {
    const t = file(
      [
        { id: 1, type: 'Source', mode: 0, widgets_values: [3] },
        { id: 2, type: 'Reroute', mode: 0, inputs: [{ name: '', type: '*', link: 10 }] },
        { id: 3, type: 'Sink', mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 11 }], widgets_values: [0.5] },
      ],
      [
        [10, 1, 0, 2, 0, 'IMAGE'],
        [11, 2, 0, 3, 0, 'IMAGE'],
      ],
    );
    const result = convertLibraryWorkflow(t, PASS_SPECS);
    expect(result.problems).toEqual([]);
    expect(result.graph['3']!.inputs).toEqual({ image: ['1', 0], strength: 0.5 });
    expect(result.graph['2']).toBeUndefined();
  });

  it('wires through a bypassed node, and leaves a muted one unwired and reported', () => {
    const nodes = (mode: number) => [
      { id: 1, type: 'Source', mode: 0, widgets_values: [3] },
      { id: 2, type: 'Filter', mode, inputs: [{ name: 'image', type: 'IMAGE', link: 10 }] },
      { id: 3, type: 'Sink', mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 11 }], widgets_values: [1] },
    ];
    const links = [
      [10, 1, 0, 2, 0, 'IMAGE'],
      [11, 2, 0, 3, 0, 'IMAGE'],
    ];
    const bypassed = convertLibraryWorkflow(file(nodes(4), links), PASS_SPECS);
    expect(bypassed.graph['3']!.inputs.image).toEqual(['1', 0]);
    expect(bypassed.problems).toEqual([]);

    const muted = convertLibraryWorkflow(file(nodes(2), links), PASS_SPECS);
    expect(muted.graph['3']!.inputs.image).toBeUndefined();
    // A required socket left empty is a graph ComfyUI will refuse; say so.
    expect(muted.problems.map((p) => p.message)).toEqual(['required input "image" is not connected.']);
  });

  it('inlines a PrimitiveNode feeding a widget turned into a socket', () => {
    const t = file(
      [
        { id: 1, type: 'Source', mode: 0, widgets_values: [3] },
        { id: 2, type: 'PrimitiveNode', mode: 0, widgets_values: [0.25] },
        {
          id: 3,
          type: 'Sink',
          mode: 0,
          inputs: [
            { name: 'image', type: 'IMAGE', link: 10 },
            { name: 'strength', type: 'FLOAT', link: 11, widget: { name: 'strength' } },
          ],
          widgets_values: [0.9],
        },
      ],
      [
        [10, 1, 0, 3, 0, 'IMAGE'],
        [11, 2, 0, 3, 1, 'FLOAT'],
      ],
    );
    expect(convertLibraryWorkflow(t, PASS_SPECS).graph['3']!.inputs).toEqual({ image: ['1', 0], strength: 0.25 });
  });

  it('refuses a workflow built on a subgraph rather than guessing its insides', () => {
    const t = file([{ id: 1, type: 'aaaa-bbbb', mode: 0 }], [], {
      definitions: { subgraphs: [{ id: 'aaaa-bbbb' }] },
    });
    const result = convertLibraryWorkflow(t, PASS_SPECS);
    expect(result.problems[0]!.message).toMatch(/subgraph aaaa-bbbb/);
  });

  it('reports too few widget values instead of shifting what is there', () => {
    const t = file([{ id: 1, type: 'Source', mode: 0, widgets_values: [] }], []);
    expect(convertLibraryWorkflow(t, PASS_SPECS).problems[0]!.message).toMatch(/fewer widget values/);
  });
});

describe('node specs from a live /object_info', () => {
  it('reads types, combos and declaration order in the shape the converter uses', () => {
    // Shaped like ComfyUI's response format, not copied from a backend: this
    // checks the adapter's parsing, and the real check is a live capture.
    const parsed = nodeSpecsFromObjectInfo({
      Example: {
        input: {
          required: {
            b: ['INT', { min: 0, max: 4, control_after_generate: true }],
            a: [['one', 'two'], {}],
            c: ['COMBO', { options: ['x'] }],
            d: ['STRING', { forceInput: true }],
          },
        },
        input_order: { required: ['a', 'b', 'c', 'd'] },
      } as never,
    });
    expect(Object.keys(parsed.Example!.required!)).toEqual(['a', 'b', 'c', 'd']);
    expect(parsed.Example!.required!.a).toMatchObject({ type: 'ENUM', values: ['one', 'two'] });
    expect(parsed.Example!.required!.b).toMatchObject({ type: 'INT', min: 0, max: 4, controlAfterGenerate: true });
    expect(parsed.Example!.required!.c).toMatchObject({ type: 'ENUM', values: ['x'] });
    expect(parsed.Example!.required!.d).toMatchObject({ forceInput: true });
  });
});
