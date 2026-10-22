import { describe, expect, it } from 'vitest';
import type { ModelVariant } from '@comfy/shared';
import { withGgufLoaders } from '../workflows/folders.js';
import { huggingFaceFamilyBase, sizedVariants, variantLabel, weightVariants } from './hugging-face-files.js';

// File lists as the Hub returned them for these repositories (trimmed).
const names = (variants: ModelVariant[]) => variants.map((variant) => variant.filename);

describe('weightVariants', () => {
  it('keeps the model and drops its VAE, example LoRA and Diffusers folders', () => {
    const variants = weightVariants(
      [
        'sd_xl_base_1.0.safetensors',
        'sd_xl_offset_example-lora_1.0.safetensors',
        'vae/diffusion_pytorch_model.safetensors',
        'text_encoder/model.safetensors',
        'unet/diffusion_pytorch_model.fp16.safetensors',
      ],
      'checkpoint',
    );
    expect(names(variants)).toEqual(['sd_xl_base_1.0.safetensors']);
  });

  it('puts fp16 before fp32, and SD 1.5 emaonly first', () => {
    expect(names(weightVariants(['RealVisXL_V5.0_fp32.safetensors', 'RealVisXL_V5.0_fp16.safetensors'], 'checkpoint'))).toEqual([
      'RealVisXL_V5.0_fp16.safetensors',
      'RealVisXL_V5.0_fp32.safetensors',
    ]);
    expect(names(weightVariants(['v1-5-pruned.safetensors', 'v1-5-pruned-emaonly.safetensors'], 'checkpoint'))[0]).toBe(
      'v1-5-pruned-emaonly.safetensors',
    );
  });

  it('orders a GGUF ladder from Q8 down, and labels it', () => {
    const variants = weightVariants(
      ['flux1-dev-Q2_K.gguf', 'flux1-dev-Q4_K_S.gguf', 'flux1-dev-F16.gguf', 'flux1-dev-Q8_0.gguf', 'flux1-dev-Q5_K_M.gguf'],
      'checkpoint',
    );
    expect(names(variants)).toEqual([
      'flux1-dev-Q8_0.gguf',
      'flux1-dev-Q5_K_M.gguf',
      'flux1-dev-Q4_K_S.gguf',
      'flux1-dev-F16.gguf',
      'flux1-dev-Q2_K.gguf',
    ]);
    expect(variantLabel(variants[0]!)).toBe('GGUF Q8_0');
  });

  it('prefers safetensors to GGUF, and drops builds no stock loader reads', () => {
    const variants = weightVariants(
      [
        'qwen-image-2.1-UC-BF16.gguf',
        'qwen-image-2.1-UC-MLX-4bit.safetensors',
        'qwen-image-2.1-UC-NVFP4.safetensors',
        'qwen-image-2.1-UC-fp8.safetensors',
        'Qwen-Image-2.1-INT8-ConvRot.safetensors',
        'Qwen-Image-2.1-text_encoder-FP8.safetensors',
      ],
      'checkpoint',
    );
    expect(names(variants)).toEqual(['qwen-image-2.1-UC-fp8.safetensors', 'qwen-image-2.1-UC-BF16.gguf']);
    expect(variantLabel(variants[0]!)).toBe('Smaller (fp8)');
  });

  it('marks fewer-step builds distilled, after the base model', () => {
    const variants = weightVariants(['sulphur_distil_bf16.safetensors', 'sulphur_dev_bf16.safetensors', 'sulphur_dev_fp8mixed.safetensors'], 'checkpoint');
    expect(names(variants)).toEqual(['sulphur_dev_bf16.safetensors', 'sulphur_distil_bf16.safetensors', 'sulphur_dev_fp8mixed.safetensors']);
    expect(variants[1]!.distilled).toBe(true);
    expect(variantLabel(variants[1]!)).toBe('Full (bf16) · distilled');
    expect(weightVariants(['flux1-schnell.safetensors'], 'checkpoint')[0]!.distilled).toBe(true);
  });

  it("reads Comfy-Org's split_files layout, and only the model's own folder", () => {
    const paths = [
      'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
      'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      'split_files/vae/wan2.2_vae.safetensors',
    ];
    expect(weightVariants(paths, 'checkpoint').map((v) => v.path)).toEqual(['split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors']);
    expect(weightVariants(paths, 'vae').map((v) => v.path)).toEqual(['split_files/vae/wan2.2_vae.safetensors']);
  });

  it('drops shards and pickles, and never offers a GGUF LoRA', () => {
    expect(weightVariants(['diffusion_pytorch_model-00001-of-00006.safetensors', 'model.ckpt', 'model.bin'], 'checkpoint')).toEqual([]);
    expect(names(weightVariants(['style.safetensors', 'style-Q8_0.gguf'], 'lora'))).toEqual(['style.safetensors']);
  });
});

describe('huggingFaceFamilyBase', () => {
  it('reads the family from the base model, the id, or the file', () => {
    expect(huggingFaceFamilyBase('someone/finetune', ['stabilityai/stable-diffusion-xl-base-1.0'], null)).toBe('SDXL');
    expect(huggingFaceFamilyBase('black-forest-labs/FLUX.1-dev', [], null)).toBe('FLUX.1');
    expect(huggingFaceFamilyBase('someone/mystery', [], 'v1-5-pruned-emaonly.safetensors')).toBe('SD1.5');
    expect(huggingFaceFamilyBase('someone/mystery', [], 'model.safetensors')).toBeNull();
  });

  it('does not read FLUX.2 or LTX-2 as the family they took their name from', () => {
    for (const [id, file] of [
      ['leejet/FLUX.2-klein-4B-GGUF', 'flux-2-klein-4b-Q8_0.gguf'],
      ['Lightricks/LTX-2', 'ltx-2-19b-dev.safetensors'],
      ['someone/LTX-2.3', 'ltx-2.3-22b-dev.safetensors'],
      ['someone/echo', 'LTX23-echoVid-Surgical-DiT-Q8_0.gguf'],
    ]) {
      expect(huggingFaceFamilyBase(id!, [], file!), id).toBeNull();
    }
    expect(huggingFaceFamilyBase('someone/fine-tune', ['Lightricks/LTX-2'], 'sulphur_dev_bf16.safetensors')).toBeNull();
    // LTX-Video 0.9 builds stay LTX-Video.
    expect(huggingFaceFamilyBase('city96/LTX-Video-0.9.5-gguf', [], 'ltx-video-2b-v0.9.5-Q8_0.gguf')).toBe('LTXV');
    expect(huggingFaceFamilyBase('someone/ltxv', [], 'ltxv-2b-0.9.6-distilled-04-25-Q8_0.gguf')).toBe('LTXV');
  });
});

describe('sizedVariants', () => {
  const variants = weightVariants(['m-fp16.safetensors', 'm-fp8.safetensors', 'm-Q8_0.gguf', 'm-Q4_K_M.gguf'], 'checkpoint');
  const tree = [
    { path: 'm-fp16.safetensors', size: 24e9, sha256: 'a' },
    { path: 'm-fp8.safetensors', size: 12e9, sha256: 'b' },
    { path: 'm-Q8_0.gguf', size: 12.7e9, sha256: 'c' },
    { path: 'm-Q4_K_M.gguf', size: 6.9e9, sha256: 'd' },
  ];
  const recommended = (memory: number | null, gguf: boolean) =>
    sizedVariants(variants, tree, memory, gguf).find((variant) => variant.recommended)!.filename;

  it('recommends the best build that fits, with room to spare', () => {
    expect(recommended(32e9, true)).toBe('m-fp16.safetensors');
    expect(recommended(16e9, true)).toBe('m-fp8.safetensors');
    expect(recommended(10e9, true)).toBe('m-Q4_K_M.gguf');
  });

  it('only recommends GGUF without GGUF support when nothing else fits', () => {
    expect(recommended(16e9, false)).toBe('m-fp8.safetensors');
    expect(recommended(10e9, false)).toBe('m-Q4_K_M.gguf');
  });

  it('falls back to the smallest when nothing fits, and to the best without a memory figure', () => {
    expect(recommended(4e9, true)).toBe('m-Q4_K_M.gguf');
    expect(recommended(null, true)).toBe('m-fp16.safetensors');
    expect(sizedVariants(variants, tree, null, true)[0]).toMatchObject({ sizeBytes: 24e9, sha256: 'a' });
  });
});

describe('withGgufLoaders', () => {
  it('swaps a UNETLoader pointed at a GGUF file for the GGUF loader, without weight_dtype', () => {
    const graph = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev-Q4_K_S.gguf', weight_dtype: 'default' } },
      '2': { class_type: 'DualCLIPLoader', inputs: { clip_name1: 't5xxl_fp16.safetensors' } },
    };
    expect(withGgufLoaders(graph)).toEqual({
      '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q4_K_S.gguf' } },
      '2': graph['2'],
    });
  });

  it('leaves a safetensors graph exactly as it was', () => {
    const graph = { '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev.safetensors', weight_dtype: 'default' } } };
    expect(withGgufLoaders(graph)).toBe(graph);
  });
});
