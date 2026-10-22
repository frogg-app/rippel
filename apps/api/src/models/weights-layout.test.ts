/**
 * The file-layout check, against real safetensors headers: the diffusers LTX
 * transformer that failed on steve-pc, and the official single-file build.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { classifyWeightKeys, familyFromWeightKeys, readSafetensorsKeys } from './weights-layout.js';

const fixture = (name: string) =>
  (JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as { keys: string[] }).keys;

describe('classifyWeightKeys', () => {
  it('calls the Muinez LTX weights diffusers-format, which no ComfyUI loader reads', () => {
    expect(classifyWeightKeys(fixture('ltxv-diffusers-keys.json'))).toBe('diffusers');
  });

  it('calls the official LTX single-file build bundled: model and VAE together', () => {
    expect(classifyWeightKeys(fixture('ltxv-single-file-keys.json'))).toBe('bundled');
  });

  it('calls the same build with its VAE stripped diffusion-only', () => {
    const keys = fixture('ltxv-single-file-keys.json').filter((key) => !key.startsWith('vae.'));
    expect(classifyWeightKeys(keys)).toBe('diffusion-only');
  });

  it('calls ComfyUI-native transformer names without a prefix diffusion-only', () => {
    const keys = fixture('ltxv-single-file-keys.json')
      .filter((key) => key.startsWith('model.diffusion_model.'))
      .map((key) => key.slice('model.diffusion_model.'.length));
    expect(classifyWeightKeys(keys)).toBe('diffusion-only');
  });

  it('says unknown rather than guessing', () => {
    expect(classifyWeightKeys([])).toBe('unknown');
    expect(classifyWeightKeys(['lora_unet_down.weight'])).toBe('unknown');
  });
});

describe('readSafetensorsKeys', () => {
  function served(header: Record<string, unknown>, status = 206) {
    const json = Buffer.from(JSON.stringify(header));
    const file = Buffer.alloc(8 + json.length);
    file.writeBigUInt64LE(BigInt(json.length), 0);
    json.copy(file, 8);
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const range = /bytes=(\d+)-(\d+)/.exec(String((init?.headers as Record<string, string>).Range))!;
      const slice = file.subarray(Number(range[1]), Number(range[2]) + 1);
      return new Response(slice, { status });
    }) as unknown as typeof fetch;
  }

  it('reads the tensor names with two range requests', async () => {
    const fetchImpl = served({ __metadata__: {}, 'time_embed.linear.weight': {}, 'proj_in.weight': {} });
    expect(await readSafetensorsKeys('https://hf.co/x/model.safetensors', fetchImpl)).toEqual([
      'time_embed.linear.weight',
      'proj_in.weight',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up quietly when the server ignores the range', async () => {
    expect(await readSafetensorsKeys('https://hf.co/x/model.safetensors', served({ a: 1 }, 200))).toBeNull();
  });

  it('does not try a non-safetensors file', async () => {
    const fetchImpl = served({});
    expect(await readSafetensorsKeys('https://hf.co/x/model.ckpt', fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('familyFromWeightKeys', () => {
  it('reads LTX-Video off the official single-file build', () => {
    expect(familyFromWeightKeys(fixture('ltxv-single-file-keys.json'))).toBe('ltx-video');
  });
  it('reads the families ComfyUI detects from their own block names', () => {
    expect(familyFromWeightKeys(['double_blocks.0.img_attn.qkv.weight', 'single_blocks.0.linear1.weight', 'img_in.weight', 'guidance_in.in_layer.weight'])).toBe('flux.1');
    expect(familyFromWeightKeys(['model.diffusion_model.double_blocks.0.x', 'model.diffusion_model.single_blocks.0.x', 'model.diffusion_model.img_in.weight', 'model.diffusion_model.txt_in.individual_token_refiner.blocks.0.x'])).toBe('hunyuan-video');
    expect(familyFromWeightKeys(['patch_embedding.weight', 'head.modulation', 'blocks.0.self_attn.q.weight'])).toBe('wan');
    expect(familyFromWeightKeys(['transformer_blocks.0.img_mod.1.weight', 'txt_norm.weight', 'img_in.weight'])).toBe('qwen-image');
    expect(familyFromWeightKeys(['conditioner.embedders.1.model.ln_final.weight', 'model.diffusion_model.input_blocks.0.0.weight'])).toBe('sdxl');
    expect(familyFromWeightKeys(['joint_blocks.0.x_block.attn.qkv.weight', 'x_embedder.proj.weight'])).toBe('sd3');
  });
  it('says nothing when the names could be two things', () => {
    expect(familyFromWeightKeys(['double_blocks.0.x', 'single_blocks.0.x', 'img_in.weight', 'double_stream_modulation_img.lin.weight'])).toBeNull();
    expect(familyFromWeightKeys(['model.diffusion_model.input_blocks.0.0.weight', 'model.diffusion_model.label_emb.0.0.weight', 'model.diffusion_model.input_blocks.1.0.time_stack.0.weight'])).toBeNull();
    expect(familyFromWeightKeys(['some.unknown.weight'])).toBeNull();
    expect(familyFromWeightKeys([])).toBeNull();
  });
});
