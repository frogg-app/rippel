import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { img2vidWan22Template as template } from './img2vid-wan22-5b.js';
import { familyFromFilename, inferFamily } from '../models/family.js';
import { findTemplate } from './registry.js';
import { withInitImage } from './init-image.js';
import { compile } from '../compiler/compile.js';

it('recognizes only the TI2V 5B filenames for this workflow', () => {
  const filename = 'Wan/wan2.2_ti2v_5B_fp16.safetensors';
  expect(familyFromFilename(filename)).toBe('wan2.2-ti2v-5b');
  expect(inferFamily({ filename, catalogueBase: 'Wan2.2' })).toBe('wan2.2-ti2v-5b');
  expect(findTemplate('img2vid', 'wan2.2-ti2v-5b')).toBe(template);
  expect(findTemplate('img2vid', familyFromFilename('wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors'))).toBeUndefined();
});

it('compiles a small job with the correct latent, companions and first frame', () => {
  const { graph } = compile({ template, modelFilenames: { wan: 'wan2.2_ti2v_5B_fp16.safetensors' }, jobId: 'test', params: {
    kind: 'img2vid', modelId: 'wan', prompt: 'A gentle wave', quality: 'fast', aspect: '16:9', batchSize: 1,
    video: { lengthSeconds: 1, fps: 5 },
  } });
  expect(graph['55']!.class_type).toBe('Wan22ImageToVideoLatent');
  expect(graph['55']!.inputs).toMatchObject({ width: 512, height: 288, length: 5, start_image: ['56', 0] });
  expect(withInitImage(graph, 'rippel/reference.png', template.manifest.initImageNodeId)['56']!.inputs.image).toBe('rippel/reference.png');
  expect(template.manifest.requires?.map((r) => r.preferred?.[0])).toEqual(['umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'wan2.2_vae.safetensors']);
});

it('uses only nodes and input names present in captured ComfyUI 0.34.0 specs', () => {
  const specs = JSON.parse(readFileSync(new URL('../library/workflows/fixtures/object-info.json', import.meta.url), 'utf8'));
  for (const node of Object.values(template.graph)) {
    expect(specs[node.class_type], node.class_type).toBeDefined();
    for (const input of Object.keys(node.inputs)) {
      if (input === 'format.codec') continue; // Dynamic input expanded from the format schema.
      expect({ ...specs[node.class_type].input.required, ...specs[node.class_type].input.optional }).toHaveProperty(input);
    }
  }
});
