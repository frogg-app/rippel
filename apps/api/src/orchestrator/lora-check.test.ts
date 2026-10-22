import { describe, expect, it } from 'vitest';
import { loraProblem } from './lora-check.js';
import { findTemplateById } from '../workflows/registry.js';

const ltx = { display_name: 'LTX-Video', filename: 'model_weights_0306.safetensors', base_model: 'ltx-video' };
const sdxl = { display_name: 'SDXL Base', filename: 'sd_xl_base_1.0.safetensors', base_model: 'sdxl' };
const unknownLora = { display_name: 'Pytorch LoRA Weights', filename: 'pytorch_lora_weights.safetensors', base_model: null };

describe('loraProblem', () => {
  it('refuses any add-on on an LTX-Video workflow, in words', () => {
    const manifest = findTemplateById('img2vid-ltxv')!.manifest;
    expect(manifest.lora).toBeUndefined();
    expect(loraProblem({ manifest, checkpoint: ltx, loras: [unknownLora] })).toBe(
      'LTX-Video workflows don’t take style add-ons. Remove Pytorch LoRA Weights and try again.',
    );
  });

  it('refuses an add-on made for another family', () => {
    const manifest = findTemplateById('txt2img-sdxl')!.manifest;
    const sd15 = { display_name: 'Hyper SD15 1step LoRA', filename: 'Hyper-SD15-1step-lora.safetensors', base_model: 'sd1.5' };
    expect(loraProblem({ manifest, checkpoint: sdxl, loras: [sd15] })).toMatch(/made for SD 1\.5.*doesn’t fit SDXL/);
  });

  it('lets through a matching add-on, an SDXL-lineage one, and one of unknown family', () => {
    const manifest = findTemplateById('txt2img-sdxl')!.manifest;
    const pony = { display_name: 'Pony style', filename: 'style.safetensors', base_model: 'pony' };
    expect(loraProblem({ manifest, checkpoint: sdxl, loras: [{ ...sdxl, display_name: 'x' }, pony, unknownLora] })).toBeNull();
  });

  it('has nothing to say about no add-ons', () => {
    expect(loraProblem({ manifest: findTemplateById('img2vid-ltxv')!.manifest, checkpoint: ltx, loras: [] })).toBeNull();
  });
});
