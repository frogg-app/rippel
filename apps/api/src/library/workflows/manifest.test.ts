import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { convertWorkflow, type ConversionSpecs } from './convert.js';
import { mapManifest } from './manifest.js';
import { parseCatalogue } from './catalogue.js';
import { img2vidWan22Template } from '../../workflows/img2vid-wan22-5b.js';
import { compile } from '../../compiler/compile.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const specs = read('object-info') as ConversionSpecs;
const entry = parseCatalogue(read('index'), '0.11.55').entries.find((entry) => entry.name === 'video_wan2_2_5B_ti2v')!;

it('maps the same controls as the hand-authored Wan 5B workflow', () => {
  const workflow = read(entry.name);
  workflow.nodes.find((node: { id: number }) => node.id === 56).mode = 0;
  const converted = convertWorkflow(workflow, specs);
  const result = mapManifest(converted, specs, entry, { id: 'library-wan', capability: 'img2vid', family: 'wan2.2-ti2v-5b' });
  expect(result.omitted).toEqual([]);
  expect(result.manifest).not.toBeNull();
  const bindings = (inputs: typeof img2vidWan22Template.manifest.inputs) => inputs.map(({ source, path }) => `${source}:${path}`).sort();
  expect(bindings(result.manifest!.inputs)).toEqual(bindings(img2vidWan22Template.manifest.inputs));
  expect(result.manifest!.initImageNodeId).toBe('56');
  expect(result.manifest!.frameQuantum).toBe(4);
  expect(result.files.map((file) => file.directory).sort()).toEqual(['diffusion_models', 'text_encoders', 'vae']);
  expect(result.manifest!.requires).toHaveLength(2);
  expect(() => compile({ template: { graph: converted.graph, manifest: result.manifest! }, modelFilenames: { wan: result.files[0]!.name }, jobId: 'test', params: {
    kind: 'img2vid', modelId: 'wan', prompt: 'A wave', quality: 'fast', aspect: '16:9', batchSize: 1,
    video: { lengthSeconds: 1, fps: 5 },
  } })).not.toThrow();
});

it('does not pretend a bypassed first frame is a working image input', () => {
  const converted = convertWorkflow(read(entry.name), specs);
  const result = mapManifest(converted, specs, entry, { id: 'library-wan', capability: 'img2vid', family: 'wan2.2-ti2v-5b' });
  expect(result.manifest).toBeNull();
  expect(result.omitted).toContain('first frame: catalogue does not identify one enabled LoadImage.');
});

it('follows sampler connections rather than prompt node titles', () => {
  const workflow = read(entry.name);
  workflow.nodes.find((node: { id: number }) => node.id === 6).title = 'NEGATIVE PROMPT';
  workflow.nodes.find((node: { id: number }) => node.id === 7).title = 'POSITIVE PROMPT';
  const result = mapManifest(convertWorkflow(workflow, specs), specs, entry, { id: 'library-wan', capability: 'txt2vid', family: 'wan2.2-ti2v-5b' });
  expect(result.manifest?.inputs.find((input) => input.source === 'prompt')?.path).toBe('6.inputs.text');
  expect(result.manifest?.inputs.find((input) => input.source === 'negativePrompt')?.path).toBe('7.inputs.text');
});
