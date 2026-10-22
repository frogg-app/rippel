/** MiniMax H3 puts its prompt, size and length on one model-specific node,
 * takes the size from an aspect picker and the step count from a switch over
 * primitives. Fixtures are the real library files (see fixtures/README.md). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertWorkflow, type ConversionSpecs } from './convert.js';
import { mapManifest } from './manifest.js';
import { parseCatalogue } from './catalogue.js';
import { rebindCheckpoint } from './rebind.js';
import { compile } from '../../compiler/compile.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const specs = read('minimax-h3-object-info') as ConversionSpecs;
const entries = parseCatalogue(read('minimax-h3-index'), '0.11.93').entries;
const entry = (name: string) => entries.find((candidate) => candidate.name === name)!;
const bindings = (inputs: readonly { source: string; path: string }[]) => Object.fromEntries(inputs.map(({ source, path }) => [source, path]));

function mapped(name: string, capability: 'txt2vid' | 'img2vid') {
  const converted = convertWorkflow(read(name), specs);
  const mapping = mapManifest(converted, specs, entry(name), { id: name, capability, family: 'minimax' });
  return { converted, mapping };
}

describe('MiniMax H3 text to video', () => {
  const { converted, mapping } = mapped('video_minimax_h3_t2v', 'txt2vid');

  it('finds every control on the MiniMax node and its primitives', () => {
    expect(mapping.omitted).toEqual([]);
    expect(bindings(mapping.manifest!.inputs)).toEqual({
      prompt: '140_131.inputs.prompt', width: '140_131.inputs.width', height: '140_131.inputs.height',
      frameCount: '140_131.inputs.length', fps: '140_130.inputs.fps', seed: '140_129.inputs.noise_seed',
      // The switch is off in the official file, so the 20-step primitive is the one used.
      steps: '140_137.inputs.value', sampler: '140_123.inputs.sampler_name', scheduler: '140_124.inputs.scheduler',
      checkpointFilename: '140_127.inputs.unet_name', filenamePrefix: '92.inputs.filename_prefix',
    });
    expect(mapping.manifest!.frameQuantum).toBe(1);
    expect(mapping.manifest!.inputs.find((input) => input.source === 'frameCount')!.constraint).toEqual({ kind: 'int', min: 5, max: 124, step: 1 });
  });

  it('turns the aspect picker into the sizes it gives for each of rippel\'s aspects', () => {
    // 0.4 megapixels to a multiple of 32, as ResolutionSelector computes it.
    expect(mapping.manifest!.resolutions).toEqual({
      '1:1': { width: 640, height: 640 }, '3:2': { width: 800, height: 544 }, '2:3': { width: 544, height: 800 },
      '16:9': { width: 864, height: 480 }, '9:16': { width: 480, height: 864 },
    });
    expect(converted.graph['115']).toBeUndefined();
    expect(converted.graph['140_131']!.inputs).toMatchObject({ width: 864, height: 480, length: 124 });
  });

  it('drops the turbo branch the switch does not take, so its LoRA is not downloaded', () => {
    const classes = Object.values(converted.graph).map((node) => node.class_type);
    expect(classes).not.toContain('ComfySwitchNode');
    expect(classes).not.toContain('LoraLoaderModelOnly');
    expect(classes).not.toContain('ComfyMathExpression');
    expect(mapping.files.map((file) => file.name)).not.toContain('minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors');
  });

  it('runs the installed reference model and compiles a job', () => {
    expect(rebindCheckpoint(converted.graph, mapping, 'minimax_h3_ref2va_pruned_int8_convrot.safetensors')).toBe(true);
    const { graph } = compile({ template: { graph: converted.graph, manifest: mapping.manifest! }, modelFilenames: { m: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors' },
      jobId: 'test', params: { kind: 'txt2vid', modelId: 'm', prompt: 'A wave', quality: 'balanced', aspect: '9:16', batchSize: 1, video: { lengthSeconds: 2, fps: 24 } } });
    expect(graph['140_131']!.inputs).toMatchObject({ prompt: 'A wave', width: 480, height: 864, length: 48 });
    expect(graph['140_137']!.inputs.value).toBe(20);
    expect(graph['140_127']!.inputs.unet_name).toBe('minimax_h3_ref2va_pruned_int8_convrot.safetensors');
  });
});

it('maps MiniMax H3 image to video once its first frame is enabled, ignoring the unwired resize', () => {
  const workflow = read('video_minimax_h3_i2v');
  const converted = convertWorkflow(workflow, specs);
  expect(converted.issues).toEqual([]);
  expect(converted.graph['119']).toBeUndefined();
  const mapping = mapManifest(converted, specs, entry('video_minimax_h3_i2v'), { id: 'i2v', capability: 'img2vid', family: 'minimax' });
  expect(mapping.omitted).toEqual([]);
  expect(mapping.manifest!.initImageNodeId).toBe('114');
  expect(bindings(mapping.manifest!.inputs)).toMatchObject({ prompt: '105_104.inputs.prompt', width: '105_104.inputs.width', frameCount: '105_104.inputs.length' });
});

it('binds a prompt typed into a primitive node on that node', () => {
  const { mapping } = mapped('video_minimax_h3_r2v', 'txt2vid');
  const prompt = mapping.manifest!.inputs.find((input) => input.source === 'prompt')!;
  expect(prompt.path).toMatch(/^\d+\.inputs\.value$/);
  expect(read('video_minimax_h3_r2v').nodes.find((node: { id: number }) => `${node.id}.inputs.value` === prompt.path).type).toBe('PrimitiveStringMultiline');
});
