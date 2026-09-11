import { expect, it, vi } from 'vitest';
import { buildFixPlan } from './fix-plan.js';
import { txt2vidLtxvDmTemplate } from '../workflows/txt2vid-ltxv-dm.js';
it('queues the LTX encoder and VAE with hashes and correct folders', async () => {
  const verify = vi.fn(async (file) => ({ ...file, sha256: file.sha256, sizeBytes: file.sizeBytes }));
  const plan = await buildFixPlan({ template: txt2vidLtxvDmTemplate, filename: 'ltx-video-2b-v0.9.1.safetensors',
    info: { UNETLoader: { input: { required: { unet_name: [['ltx-video-2b-v0.9.1.safetensors']] } } } }, verify });
  expect(plan.unavailable).toEqual([]);
  expect(plan.steps.map((step) => step.kind === 'download' ? step.request.path : '')).toEqual([
    'text_encoders/t5xxl_fp8_e4m3fn.safetensors', 'vae/ltx-video-2b-v0.9.1.safetensors']);
  expect(plan.steps.every((step) => step.kind === 'download' && step.request.sha256.length === 64)).toBe(true);
});
it('moves a misplaced primary file before installing companions', async () => {
  const plan = await buildFixPlan({ template: txt2vidLtxvDmTemplate, filename: 'ltx-video-2b-v0.9.1.safetensors',
    info: { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['ltx-video-2b-v0.9.1.safetensors']] } } } } });
  expect(plan.steps[0]).toEqual({ kind: 'move', request: { from: 'checkpoints/ltx-video-2b-v0.9.1.safetensors', to: 'diffusion_models/ltx-video-2b-v0.9.1.safetensors' } });
});
