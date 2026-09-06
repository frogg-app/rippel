/**
 * The readiness report, pinned against the reference machine.
 *
 * Every fixture below was read off http://192.168.1.10:8188 on 2026-09-06 and
 * trimmed, not invented — in particular the ComfyUI-Manager catalogue entry
 * that says `installed: "True"` for a checkpoint ComfyUI only lists under
 * `diffusion_models/`. That contradiction is the thing these tests exist to
 * keep us honest about, so it is reproduced exactly.
 */

import { describe, expect, it } from 'vitest';

import type { ModelCatalogEntry } from '@comfy/shared';
import type { ObjectInfo } from '../lib/comfy.js';
import { img2vidLtxvTemplate, txt2imgSdxlTemplate, txt2vidLtxvTemplate } from '../workflows/index.js';
import { analyse, checkpointOffers, foldersToScan, foundIn, offersFor } from './readiness.js';
import { LTXV_TEXT_ENCODER_REQUIREMENT } from '../workflows/index.js';

const BACKEND = { id: 'b1', name: 'workshop', base_url: 'http://192.168.1.10:8188' };

/** `/object_info`, trimmed to the loaders these graphs use. */
const INFO: ObjectInfo = {
  CheckpointLoaderSimple: {
    input: {
      required: {
        ckpt_name: [
          ['SDXL\\sd_xl_base_1.0.safetensors', 'hunyuan_video_720p_fp8_e4m3fn.safetensors'],
          {},
        ],
      },
    },
  },
  UNETLoader: { input: { required: { unet_name: [['ltx-video-2b-v0.9.1.safetensors'], {}] } } },
  CLIPLoader: { input: { required: { clip_name: [[], {}] } } },
  CLIPTextEncode: {},
  EmptyLTXVLatentVideo: {},
  LTXVConditioning: {},
  KSamplerSelect: {},
  LTXVScheduler: {},
  SamplerCustom: {},
  VAEDecode: {},
  SaveWEBM: {},
  LoadImage: {},
  LTXVPreprocess: {},
  LTXVImgToVideo: {},
  KSampler: {},
  EmptyLatentImage: {},
  SaveImage: {},
  VAEEncode: {},
  LoraLoader: {},
};

/** `GET /api/models/<folder>` for the folders a video template makes us scan. */
const FOLDERS = new Map<string, readonly string[]>([
  ['checkpoints', ['SDXL\\sd_xl_base_1.0.safetensors', 'hunyuan_video_720p_fp8_e4m3fn.safetensors']],
  ['diffusion_models', ['ltx-video-2b-v0.9.1.safetensors']],
  ['text_encoders', []],
  ['vae', []],
]);

/** `GET /externalmodel/getlist?mode=cache`, the entries that matter here. */
const CATALOGUE: ModelCatalogEntry[] = [
  {
    ref: 'checkpoints/LTXV/ltx-video-2b-v0.9.1.safetensors',
    name: 'LTX-Video 2B v0.9.1 Checkpoint',
    filename: 'ltx-video-2b-v0.9.1.safetensors',
    type: 'checkpoint',
    base: 'LTX-Video',
    description: null,
    size: '5.72GB',
    url: 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.1.safetensors',
    // Manager's own answer. It is not a lie about the disk, but it is not an
    // answer to "can this run" either.
    installed: true,
  },
  {
    ref: 'checkpoints/LTXV/ltx-video-2b-v0.9.safetensors',
    name: 'LTX-Video 2B v0.9 Checkpoint',
    filename: 'ltx-video-2b-v0.9.safetensors',
    type: 'checkpoint',
    base: 'LTX-Video',
    description: null,
    size: '9.37GB',
    url: 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.safetensors',
    installed: false,
  },
  {
    ref: 'text_encoders/t5/t5xxl_fp16.safetensors',
    name: 'comfyanonymous/flux_text_encoders - t5xxl (fp16)',
    filename: 't5xxl_fp16.safetensors',
    type: 'clip',
    base: 't5',
    description: 'Text Encoders for FLUX (fp16)',
    size: '9.79GB',
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors',
    installed: false,
  },
  {
    ref: 'text_encoders/t5/t5xxl_fp8_e4m3fn.safetensors',
    name: 'comfyanonymous/flux_text_encoders - t5xxl (fp8_e4m3fn)',
    filename: 't5xxl_fp8_e4m3fn.safetensors',
    type: 'clip',
    base: 't5',
    description: 'Text Encoders for FLUX (fp8_e4m3fn)',
    size: '4.89GB',
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
    installed: false,
  },
  {
    ref: 'loras/HyperSD/Hyper-SD15-1step-lora.safetensors',
    name: 'Hyper-SD15 1step LoRA',
    filename: 'Hyper-SD15-1step-lora.safetensors',
    type: 'lora',
    base: 'SD1.5',
    description: null,
    size: '128MB',
    url: 'https://example.invalid/hyper.safetensors',
    installed: true,
  },
];

function ltxReadiness(template = txt2vidLtxvTemplate) {
  return analyse({
    backend: BACKEND,
    template,
    // What our models table records for the LTX file the box has.
    checkpointFilename: 'ltx-video-2b-v0.9.1.safetensors',
    modelId: 'm1',
    modelLabel: 'LTX-Video 2B v0.9.1',
    info: INFO,
    catalogue: CATALOGUE,
    catalogueError: null,
    folders: FOLDERS,
  });
}

describe('readiness for the LTX-Video templates on the reference box', () => {
  it('is not ready, and says so for both video templates', () => {
    expect(ltxReadiness().ready).toBe(false);
    expect(ltxReadiness(img2vidLtxvTemplate).ready).toBe(false);
  });

  it('reports the checkpoint as misfiled, not as missing', () => {
    const checkpoint = ltxReadiness().requirements.find((r) => r.id === 'checkpoint')!;
    // The distinction that matters: "you do not have this file" would be false,
    // and would send the operator off to download 5.7GB they already have.
    expect(checkpoint.status).toBe('misfiled');
    expect(checkpoint.misfiled).not.toBeNull();
    expect(checkpoint.misfiled!.foundInFolders).toEqual(['diffusion_models']);
    expect(checkpoint.misfiled!.requiredFolder).toBe('checkpoints');
    expect(checkpoint.misfiled!.loaderClass).toBe('CheckpointLoaderSimple');
  });

  it('names Manager’s own contradicting entry, because it explains the dead end', () => {
    const checkpoint = ltxReadiness().requirements.find((r) => r.id === 'checkpoint')!;
    expect(checkpoint.misfiled!.catalogueRef).toBe(
      'checkpoints/LTXV/ltx-video-2b-v0.9.1.safetensors',
    );
    expect(checkpoint.misfiled!.catalogueSavePath).toBe('checkpoints/LTXV');
    expect(checkpoint.misfiled!.instruction).toContain('models/diffusion_models/');
    expect(checkpoint.misfiled!.instruction).toContain('models/checkpoints/');
    expect(checkpoint.misfiled!.instruction).toContain('will not download it again');
  });

  it('offers an alternative build we could install instead of the misfiled one', () => {
    const checkpoint = ltxReadiness().requirements.find((r) => r.id === 'checkpoint')!;
    const refs = checkpoint.offers.map((e) => e.ref);
    expect(refs).toContain('checkpoints/LTXV/ltx-video-2b-v0.9.safetensors');
  });

  it('reports the empty text_encoders folder as a plain missing file', () => {
    const encoder = ltxReadiness().requirements.find((r) => r.id === 'text-encoder')!;
    expect(encoder.status).toBe('missing');
    expect(encoder.misfiled).toBeNull();
    expect(encoder.available).toEqual([]);
    expect(encoder.loaderClass).toBe('CLIPLoader');
    expect(encoder.loaderInput).toBe('clip_name');
    expect(encoder.why).toContain('no text encoder');
  });

  it('names real catalogue entries that would supply the T5, fp16 first', () => {
    const encoder = ltxReadiness().requirements.find((r) => r.id === 'text-encoder')!;
    expect(encoder.offers.map((e) => e.filename)).toEqual([
      't5xxl_fp16.safetensors',
      't5xxl_fp8_e4m3fn.safetensors',
    ]);
  });

  it('recommends exactly one download, and only for the gap a download fixes', () => {
    const readiness = ltxReadiness();
    // One entry, not five. The first live run of this returned every offer for
    // every gap — 32 entries, ~250 GB — which is an outage, not a fix.
    expect(readiness.installable.map((e) => e.ref)).toEqual([
      'text_encoders/t5/t5xxl_fp16.safetensors',
    ]);
    // The misfiled checkpoint contributes nothing: a different build is not
    // the model the user picked, and the original would still be misfiled.
    expect(readiness.installable.some((e) => e.type === 'checkpoint')).toBe(false);
    expect(readiness.installable.every((e) => !e.installed)).toBe(true);
  });

  it('carries the move-this-file instruction as a manual step', () => {
    const steps = ltxReadiness().manualSteps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain('ltx-video-2b-v0.9.1.safetensors');
  });

  it('goes green once the two gaps are closed', () => {
    const fixed = analyse({
      backend: BACKEND,
      template: txt2vidLtxvTemplate,
      checkpointFilename: 'LTXV\\ltx-video-2b-v0.9.1.safetensors',
      modelId: 'm1',
      modelLabel: 'LTX-Video 2B v0.9.1',
      info: {
        ...INFO,
        CheckpointLoaderSimple: {
          input: { required: { ckpt_name: [['LTXV/ltx-video-2b-v0.9.1.safetensors'], {}] } },
        },
        CLIPLoader: { input: { required: { clip_name: [['t5/t5xxl_fp16.safetensors'], {}] } } },
      },
      catalogue: CATALOGUE,
      catalogueError: null,
      folders: FOLDERS,
    });
    expect(fixed.ready).toBe(true);
    expect(fixed.manualSteps).toEqual([]);
    expect(fixed.installable).toEqual([]);
    // And it names the encoder the backend has, not the graph's literal.
    const encoder = fixed.requirements.find((r) => r.id === 'text-encoder')!;
    expect(encoder.resolved).toBe('t5/t5xxl_fp16.safetensors');
  });
});

describe('readiness for a template that is fine', () => {
  it('reports SDXL as ready on the same box', () => {
    const readiness = analyse({
      backend: BACKEND,
      template: txt2imgSdxlTemplate,
      checkpointFilename: 'SDXL/sd_xl_base_1.0.safetensors',
      modelId: 'm2',
      modelLabel: 'SDXL 1.0',
      info: INFO,
      catalogue: CATALOGUE,
      catalogueError: null,
      folders: FOLDERS,
    });
    // Windows separator on the backend, forward slash in our database. A
    // readiness screen that got this wrong would condemn a working model.
    expect(readiness.ready).toBe(true);
    expect(readiness.requirements).toHaveLength(1);
    expect(readiness.requirements[0]!.status).toBe('satisfied');
  });
});

describe('missing node classes', () => {
  it('are reported as a manual step, since no download fixes them', () => {
    const { SaveWEBM: _dropped, ...withoutSaveWebm } = INFO;
    const readiness = analyse({
      backend: BACKEND,
      template: txt2vidLtxvTemplate,
      checkpointFilename: 'ltx-video-2b-v0.9.1.safetensors',
      modelId: null,
      modelLabel: null,
      info: withoutSaveWebm,
      catalogue: CATALOGUE,
      catalogueError: null,
      folders: FOLDERS,
    });
    expect(readiness.missingNodeClasses).toEqual(['SaveWEBM']);
    expect(readiness.ready).toBe(false);
    expect(readiness.manualSteps.some((s) => s.includes('SaveWEBM'))).toBe(true);
  });
});

describe('helpers', () => {
  it('scans only the folders this template could hide a file in', () => {
    expect(foldersToScan(txt2vidLtxvTemplate).sort()).toEqual([
      'checkpoints',
      'clip',
      'diffusers',
      'diffusion_models',
      'text_encoders',
      'unet',
    ]);
    // An image template has no companion models, so it scans far less.
    expect(foldersToScan(txt2imgSdxlTemplate).sort()).toEqual([
      'checkpoints',
      'diffusers',
      'diffusion_models',
      'unet',
    ]);
  });

  it('matches a file across folders on its basename, separators and all', () => {
    expect(foundIn('LTXV/ltx-video-2b-v0.9.1.safetensors', FOLDERS)).toEqual(['diffusion_models']);
    expect(foundIn('sd_xl_base_1.0.safetensors', FOLDERS)).toEqual(['checkpoints']);
    expect(foundIn('nothing.safetensors', FOLDERS)).toEqual([]);
  });

  it('does not offer every checkpoint in the catalogue for a bare type match', () => {
    // The T5 requirement matches on base and filename; a requirement with an
    // empty match (the synthetic checkpoint one) must offer nothing here.
    expect(offersFor(LTXV_TEXT_ENCODER_REQUIREMENT, CATALOGUE)).toHaveLength(2);
    expect(
      offersFor({ ...LTXV_TEXT_ENCODER_REQUIREMENT, match: {} }, CATALOGUE),
    ).toHaveLength(0);
  });

  it('finds sibling builds of a checkpoint, and never an unrelated family', () => {
    const offers = checkpointOffers('ltx-video-2b-v0.9.1.safetensors', CATALOGUE);
    expect(offers[0]!.installed).toBe(true);
    expect(offers.map((e) => e.filename)).toEqual([
      'ltx-video-2b-v0.9.1.safetensors',
      'ltx-video-2b-v0.9.safetensors',
    ]);
    expect(checkpointOffers('sd_xl_base_1.0.safetensors', CATALOGUE)).toEqual([]);
  });

  it('never offers a LoRA as a replacement checkpoint', () => {
    // The live catalogue files LTX-Video LoRAs under the same `base`, and the
    // first run of this against the real box duly offered them as alternative
    // checkpoints. Same family is not the same thing.
    const withLora: ModelCatalogEntry[] = [
      ...CATALOGUE,
      {
        ref: 'loras/ltxv-13b-0.9.7-distilled-lora128.safetensors',
        name: 'LTXV distilled LoRA',
        filename: 'ltxv-13b-0.9.7-distilled-lora128.safetensors',
        type: 'lora',
        base: 'LTX-Video',
        description: null,
        size: '1.33GB',
        url: 'https://example.invalid/lora.safetensors',
        installed: false,
      },
    ];
    expect(
      checkpointOffers('ltx-video-2b-v0.9.1.safetensors', withLora).every(
        (e) => e.type === 'checkpoint',
      ),
    ).toBe(true);
  });
});
