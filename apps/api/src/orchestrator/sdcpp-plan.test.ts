import { describe, expect, it } from 'vitest';
import type { SdcppModelFile, SdcppRecipe } from '../lib/sdcpp.js';
import { discoverSdcppModels } from '../lib/sdcpp.js';
import { fallbackDimensions, planFor, recipeIdFor, sdcppSampler, sdcppScheduler } from './sdcpp-plan.js';
import { buildSdcppRequest, holdsPlan } from './sdcpp.js';
import type { JobRow } from './jobs.js';

/** Recipes as sd-server a77d362 reports them, trimmed to the fields read. */
const RECIPES: SdcppRecipe[] = [
  {
    id: 'sd-turbo', name: 'SD Turbo',
    defaults: { cfg_scale: 1, height: 512, sampling_method: 'euler', scheduler: 'discrete', steps: 1, width: 512 },
    slots: [
      { id: 'model', category: 'checkpoints', categories: ['checkpoints'], required: true, label: 'Checkpoint' },
      { id: 'vae', category: 'vae', categories: ['vae'], required: false, label: 'VAE' },
      { id: 'tae', category: 'vae', categories: ['vae', 'vae_approx'], required: false, label: 'TAE' },
    ],
  },
  {
    id: 'z-image-turbo', name: 'Z-Image Turbo',
    defaults: { cfg_scale: 1, height: 1024, sampling_method: 'euler', steps: 9, width: 1024 },
    required_any: [['vae', 'tae']],
    slots: [
      { id: 'diffusion_model', category: 'diffusion_models', categories: ['diffusion_models'], required: true, label: 'Diffusion model' },
      { id: 'llm', category: 'text_encoders', categories: ['text_encoders'], required: true, label: 'Qwen 3 Text Encoder' },
      { id: 'vae', category: 'vae', categories: ['vae'], required: false, label: 'VAE' },
      { id: 'tae', category: 'vae', categories: ['vae', 'vae_approx'], required: false, label: 'TAE' },
    ],
  },
  {
    id: 'wan21-t2v', name: 'Wan 2.1 T2V',
    defaults: { cfg_scale: 5, flow_shift: 5, fps: 16, height: 720, sampling_method: 'euler', steps: 20, video_frames: 33, width: 1280 },
    required_any: [['vae', 'tae']],
    slots: [
      { id: 'diffusion_model', category: 'diffusion_models', categories: ['diffusion_models'], required: true, label: 'Diffusion model' },
      { id: 't5xxl', category: 'text_encoders', categories: ['text_encoders'], required: true, label: 'UMT5-XXL' },
      { id: 'vae', category: 'vae', categories: ['vae'], required: false, label: 'Wan 2.1 VAE' },
      { id: 'tae', category: 'vae', categories: ['vae', 'vae_approx'], required: false, label: 'TAE' },
    ],
  },
];

/** The dev box's model folder as `/sdcpp/v1/model-files` listed it. */
const FILES: SdcppModelFile[] = [
  { id: 'checkpoints/sd_turbo-f16-q8_0.gguf', name: 'sd_turbo-f16-q8_0.gguf', category: 'checkpoints', root: '@r', relative_path: 'checkpoints/sd_turbo-f16-q8_0.gguf' },
  { id: 'diffusion_models/z_image_turbo-Q3_K.gguf', name: 'z_image_turbo-Q3_K.gguf', category: 'diffusion_models', root: '@r', relative_path: 'diffusion_models/z_image_turbo-Q3_K.gguf' },
  { id: 'diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors', name: 'wan2.1_t2v_1.3B_fp16.safetensors', category: 'diffusion_models', root: '@r', relative_path: 'diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors' },
  { id: 'text_encoders/Qwen3-4B-Instruct-2507-Q3_K_S.gguf', name: 'Qwen3-4B-Instruct-2507-Q3_K_S.gguf', category: 'text_encoders', root: '@r', relative_path: 'text_encoders/Qwen3-4B-Instruct-2507-Q3_K_S.gguf' },
  { id: 'text_encoders/umt5-xxl-encoder-Q3_K_S.gguf', name: 'umt5-xxl-encoder-Q3_K_S.gguf', category: 'text_encoders', root: '@r', relative_path: 'text_encoders/umt5-xxl-encoder-Q3_K_S.gguf' },
  { id: 'vae/ae.safetensors', name: 'ae.safetensors', category: 'vae', root: '@r', relative_path: 'vae/ae.safetensors' },
  { id: 'vae/wan_2.1_vae.safetensors', name: 'wan_2.1_vae.safetensors', category: 'vae', root: '@r', relative_path: 'vae/wan_2.1_vae.safetensors' },
  { id: 'loras/nested/detail.safetensors', name: 'detail.safetensors', category: 'loras', root: '@r', relative_path: 'loras/nested/detail.safetensors' },
];

describe('discoverSdcppModels', () => {
  it('files sd-server categories under the catalogue types ComfyUI discovery uses', () => {
    const found = discoverSdcppModels(FILES);
    expect(found.find((f) => f.filename === 'sd_turbo-f16-q8_0.gguf')?.type).toBe('checkpoint');
    expect(found.find((f) => f.filename === 'z_image_turbo-Q3_K.gguf')?.type).toBe('checkpoint');
    expect(found.find((f) => f.filename === 'umt5-xxl-encoder-Q3_K_S.gguf')?.type).toBe('clip');
    expect(found.find((f) => f.filename === 'ae.safetensors')?.type).toBe('vae');
    // Subfolders survive: the filename is the path below the category, like ComfyUI's.
    expect(found.find((f) => f.type === 'lora')?.filename).toBe('nested/detail.safetensors');
  });
});

describe('recipeIdFor', () => {
  it('chooses by family and refines by filename', () => {
    expect(recipeIdFor('sd2.x', 'sd_turbo-f16-q8_0.gguf', 'txt2img')).toBe('sd-turbo');
    expect(recipeIdFor('sd2.x', 'v2-1_768-ema-pruned.safetensors', 'txt2img')).toBe('sd2-768-checkpoint');
    expect(recipeIdFor('z-image', 'z_image_turbo-Q3_K.gguf', 'img2img')).toBe('z-image-turbo');
    expect(recipeIdFor('flux.1', 'flux1-schnell-Q4.gguf', 'txt2img')).toBe('flux1-schnell');
    expect(recipeIdFor('wan', 'wan2.1_t2v_1.3B_fp16.safetensors', 'txt2vid')).toBe('wan21-t2v');
    expect(recipeIdFor('wan', 'wan2.2_i2v_high_noise_14B.safetensors', 'img2vid')).toBe('wan22-i2v');
    expect(recipeIdFor('sdxl', 'juggernautXL.safetensors', 'txt2img')).toBe('sdxl-checkpoint');
  });

  it('says no rather than guessing for the wrong mode or an unknown family', () => {
    expect(recipeIdFor('sdxl', 'x.safetensors', 'txt2vid')).toBeNull();
    expect(recipeIdFor('wan', 'wan2.1.safetensors', 'txt2img')).toBeNull();
    expect(recipeIdFor('ltx-video', 'ltx-video-2b-v0.9.1.safetensors', 'txt2vid')).toBeNull();
    expect(recipeIdFor(null, 'mystery.safetensors', 'txt2img')).toBeNull();
  });
});

describe('planFor', () => {
  it('fills every slot of a single-file recipe from the checkpoint alone', () => {
    const result = planFor({ family: 'sd2.x', checkpointFilename: 'sd_turbo-f16-q8_0.gguf', modelLabel: 'SD Turbo', capability: 'txt2img', files: FILES, recipes: RECIPES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.recipe).toBe('sd-turbo');
    expect(result.plan.models).toEqual({ model: 'checkpoints/sd_turbo-f16-q8_0.gguf' });
    expect(result.plan.kind).toBe('img_gen');
  });

  it('picks the right companions by name: Qwen3 and ae for Z-Image, UMT5 and the Wan VAE for Wan', () => {
    const z = planFor({ family: 'z-image', checkpointFilename: 'z_image_turbo-Q3_K.gguf', modelLabel: 'Z-Image Turbo', capability: 'txt2img', files: FILES, recipes: RECIPES });
    expect(z.ok).toBe(true);
    if (z.ok) {
      expect(z.plan.models).toEqual({
        diffusion_model: 'diffusion_models/z_image_turbo-Q3_K.gguf',
        llm: 'text_encoders/Qwen3-4B-Instruct-2507-Q3_K_S.gguf',
        vae: 'vae/ae.safetensors',
      });
    }
    const wan = planFor({ family: 'wan', checkpointFilename: 'wan2.1_t2v_1.3B_fp16.safetensors', modelLabel: 'Wan 2.1', capability: 'txt2vid', files: FILES, recipes: RECIPES });
    expect(wan.ok).toBe(true);
    if (wan.ok) {
      expect(wan.plan.kind).toBe('vid_gen');
      expect(wan.plan.models).toEqual({
        diffusion_model: 'diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors',
        t5xxl: 'text_encoders/umt5-xxl-encoder-Q3_K_S.gguf',
        vae: 'vae/wan_2.1_vae.safetensors',
      });
    }
  });

  it('reports a gap with the recipe label when the encoder is absent', () => {
    const files = FILES.filter((f) => !/Qwen3/.test(f.name));
    const result = planFor({ family: 'z-image', checkpointFilename: 'z_image_turbo-Q3_K.gguf', modelLabel: 'Z-Image Turbo', capability: 'txt2img', files, recipes: RECIPES });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.plan?.gaps.map((g) => g.slot)).toEqual(['llm']);
    expect(result.reason).toContain('Qwen 3 Text Encoder');
    expect(result.reason).toContain('text_encoders/');
  });

  it('tells the user to move a model filed in the wrong folder instead of failing the load', () => {
    const files: SdcppModelFile[] = [
      { id: 'checkpoints/z_image_turbo-Q3_K.gguf', name: 'z_image_turbo-Q3_K.gguf', category: 'checkpoints', root: '@r', relative_path: 'checkpoints/z_image_turbo-Q3_K.gguf' },
      ...FILES.filter((f) => f.category !== 'diffusion_models'),
    ];
    const result = planFor({ family: 'z-image', checkpointFilename: 'z_image_turbo-Q3_K.gguf', modelLabel: 'Z-Image Turbo', capability: 'txt2img', files, recipes: RECIPES });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Move z_image_turbo-Q3_K.gguf from checkpoints\/ to diffusion_models\//);
  });

  it('matches ComfyUI-style backslash filenames to sd-server ids', () => {
    const result = planFor({ family: 'sd2.x', checkpointFilename: 'SD2\\turbo.safetensors', modelLabel: 'x', capability: 'txt2img', recipes: RECIPES,
      files: [{ id: 'checkpoints/SD2/turbo.safetensors', name: 'turbo.safetensors', category: 'checkpoints', root: '@r', relative_path: 'checkpoints/SD2/turbo.safetensors' }] });
    expect(result.ok).toBe(true);
  });
});

describe('fallbackDimensions', () => {
  it('keeps the recipe area and snaps to 64', () => {
    expect(fallbackDimensions('1:1', { width: 1024, height: 1024 })).toEqual({ width: 1024, height: 1024 });
    const wide = fallbackDimensions('16:9', { width: 1024, height: 1024 });
    expect(wide.width % 64).toBe(0);
    expect(wide.height % 64).toBe(0);
    expect(wide.width / wide.height).toBeGreaterThan(1.6);
    expect(fallbackDimensions('2:3', {}).height).toBeGreaterThan(fallbackDimensions('2:3', {}).width);
  });
});

describe('sampler and scheduler names', () => {
  it('translates ComfyUI names and drops unknown ones so the recipe default applies', () => {
    expect(sdcppSampler('euler_ancestral')).toBe('euler_a');
    expect(sdcppSampler('dpmpp_2m')).toBe('dpm++2m');
    expect(sdcppSampler('dpm++2m')).toBe('dpm++2m');
    expect(sdcppSampler('uni_pc')).toBeUndefined();
    expect(sdcppScheduler('karras')).toBe('karras');
    expect(sdcppScheduler('normal')).toBe('normal');
    expect(sdcppScheduler('made-up')).toBeUndefined();
  });
});

function jobRow(params: Partial<JobRow['params']>): JobRow {
  return {
    id: 'job-1', user_id: 'u', kind: 'txt2img', status: 'queued', template_id: null, backend_id: null, comfy_prompt_id: null,
    progress: {}, priority: 0, error: null, created_at: new Date(), started_at: null, finished_at: null,
    params: { kind: 'txt2img', prompt: 'a fox', modelId: '00000000-0000-4000-8000-000000000000', quality: 'balanced', aspect: '1:1', batchSize: 2, ...params } as JobRow['params'],
  };
}

describe('buildSdcppRequest', () => {
  const plan = { recipe: 'z-image-turbo', recipeName: 'Z-Image Turbo', kind: 'img_gen' as const, models: {}, gaps: [], defaults: RECIPES[1]!.defaults! };

  it('keeps a distilled recipe at its own step count whatever the quality or the family template says', () => {
    for (const quality of ['fast', 'balanced', 'high'] as const) {
      const body = buildSdcppRequest({ job: jobRow({ quality }), plan, preset: { steps: 16, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras' }, dimensions: { width: 1024, height: 1024 }, seed: 7, frames: null, initImage: null, loras: [] });
      const sp = body.sample_params as { sample_steps: number; guidance: { txt_cfg: number } };
      expect(sp.sample_steps).toBe(9);
      expect(sp.guidance.txt_cfg).toBe(1);
    }
    const explicit = buildSdcppRequest({ job: jobRow({ advanced: { steps: 4 } }), plan, preset: null, dimensions: { width: 1024, height: 1024 }, seed: 7, frames: null, initImage: null, loras: [] });
    expect((explicit.sample_params as { sample_steps: number }).sample_steps).toBe(4);
  });

  it('scales a full recipe by quality, and lets a template preset win over both', () => {
    const wan = { ...plan, recipe: 'wan21-t2v', kind: 'vid_gen' as const, defaults: RECIPES[2]!.defaults! };
    const fast = buildSdcppRequest({ job: jobRow({ kind: 'txt2vid', quality: 'fast', video: { lengthSeconds: 2, fps: 16 } }), plan: wan, preset: null, dimensions: { width: 832, height: 480 }, seed: 1, frames: 33, initImage: null, loras: [] });
    expect((fast.sample_params as { sample_steps: number }).sample_steps).toBe(12);
    expect(fast.video_frames).toBe(33);
    expect(fast.fps).toBe(16);
    expect(fast.output_format).toBe('webp');
    expect(fast).not.toHaveProperty('batch_count');

    const preset = buildSdcppRequest({ job: jobRow({ kind: 'txt2vid', quality: 'fast', video: { lengthSeconds: 2, fps: 16 } }), plan: wan, preset: { steps: 30, cfg: 6.5, sampler: 'dpmpp_2m', scheduler: 'karras' }, dimensions: { width: 832, height: 480 }, seed: 1, frames: 33, initImage: null, loras: [] });
    const sp = preset.sample_params as { sample_steps: number; sample_method: string; scheduler: string; guidance: { txt_cfg: number } };
    expect(sp.sample_steps).toBe(30);
    expect(sp.guidance.txt_cfg).toBe(6.5);
    expect(sp.sample_method).toBe('dpm++2m');
    expect(sp.scheduler).toBe('karras');
  });

  it('carries the batch, the seed, the previews and the init image through', () => {
    const body = buildSdcppRequest({
      job: jobRow({ kind: 'img2img', references: [{ role: 'init', influence: 0.4, source: { from: 'upload', uploadId: '00000000-0000-4000-8000-000000000001' } }] }),
      plan, preset: null, dimensions: { width: 768, height: 1024 }, seed: 1234, frames: null, initImage: 'data:image/png;base64,AAAA', loras: [{ path: 'detail.safetensors', multiplier: 0.8 }],
    });
    expect(body.batch_count).toBe(2);
    expect(body.seed).toBe(1234);
    expect(body.width).toBe(768);
    expect(body.preview).toBe('proj');
    expect(body.init_image).toBe('data:image/png;base64,AAAA');
    expect(body.strength).toBe(0.4);
    expect(body.lora).toEqual([{ path: 'detail.safetensors', multiplier: 0.8 }]);
  });
});

describe('holdsPlan', () => {
  const plan = { recipe: 'sd-turbo', models: { model: 'checkpoints/sd_turbo-f16-q8_0.gguf' } };
  it('is true only for a ready server holding exactly these files', () => {
    expect(holdsPlan({ state: 'ready', recipe: 'sd-turbo', models: { model: 'checkpoints/sd_turbo-f16-q8_0.gguf' } }, plan)).toBe(true);
    expect(holdsPlan({ state: 'ready', recipe: 'sd-turbo', models: { model: 'checkpoints/sd_turbo-f16-q8_0.gguf', vae: 'vae/x.safetensors' } }, plan)).toBe(true);
    expect(holdsPlan({ state: 'loading', recipe: 'sd-turbo', models: { model: 'checkpoints/sd_turbo-f16-q8_0.gguf' } }, plan)).toBe(false);
    expect(holdsPlan({ state: 'ready', recipe: 'sdxl-turbo', models: { model: 'checkpoints/sd_turbo-f16-q8_0.gguf' } }, plan)).toBe(false);
    expect(holdsPlan({ state: 'ready', recipe: 'sd-turbo', models: { model: 'checkpoints/other.gguf' } }, plan)).toBe(false);
    expect(holdsPlan({ state: 'empty', recipe: null, models: {} }, plan)).toBe(false);
  });
});
