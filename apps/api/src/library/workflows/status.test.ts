import { expect, it } from 'vitest';
import { assessWorkflow } from './status.js';
import { txt2imgSdxlTemplate } from '../../workflows/txt2img-sdxl.js';
const base = { openSource: true, manifest: txt2imgSdxlTemplate.manifest,
  graph: { '1': { class_type: 'UNETLoader', inputs: { unet_name: 'model.safetensors' } } },
  files: [{ name: 'model.safetensors', directory: 'diffusion_models', url: 'https://huggingface.co/a/b/resolve/main/model.safetensors', paths: ['1.inputs.unet_name'], sizeBytes: 100 }],
  omitted: [], info: { UNETLoader: { input: { required: { unet_name: [['model.safetensors']] } } } } };
it('requires a passing test even with every file present', () => {
  expect(assessWorkflow(base).status).toBe('untested');
  expect(assessWorkflow({ ...base, testStatus: 'ready' }).status).toBe('ready');
});
it('invalidates previous readiness when files or nodes disappear', () => {
  const missing = assessWorkflow({ ...base, testStatus: 'ready', info: { UNETLoader: { input: { required: { unet_name: [[]] } } } } });
  expect(missing.status).toBe('needs-files');
  expect(missing.downloadBytes).toBe(100);
  expect(missing.missingFiles).toEqual(base.files);
  expect(assessWorkflow({ ...base, info: {} }).missingNodes).toEqual(['UNETLoader']);
});
it('reports cloud, unsupported and impossible memory budgets explicitly', () => {
  expect(assessWorkflow({ ...base, openSource: false }).status).toBe('cloud-only');
  expect(assessWorkflow({ ...base, manifest: null }).status).toBe('not-supported');
  expect(assessWorkflow({ ...base, memoryBytes: 99 }).status).toBe('too-big');
  expect(assessWorkflow({ ...base, memoryBytes: 100 }).status).toBe('untested');
});
