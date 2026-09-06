/**
 * The "will it run?" verdict.
 *
 * The `/object_info` fragment below is the shape the live box really returns —
 * an SDXL checkpoint under a Windows subfolder, and an **empty** `clip_name`
 * list, which is the exact reason the two LTX-Video models on that machine
 * cannot generate anything. Every expectation here is about a sentence a person
 * reads before spending 7 GB of bandwidth, so they assert the wording is
 * specific, not merely that a status came back.
 */

import { describe, expect, it } from 'vitest';
import type { ObjectInfo } from '../lib/comfy.js';
import { folderForSavePath, isUsable, runnabilityFor } from './runnability.js';

/**
 * Every node class our shipped templates use. Classes with no file-valued input
 * are declared with empty inputs, which is what a real backend does too — the
 * check only ever looks at combo-valued file inputs.
 */
function objectInfo(options: { checkpoints: string[]; clips: string[]; omit?: string[] }): ObjectInfo {
  const classes = [
    'CLIPTextEncode',
    'EmptyLTXVLatentVideo',
    'EmptyLatentImage',
    'KSampler',
    'KSamplerSelect',
    'LTXVConditioning',
    'LTXVImgToVideo',
    'LTXVPreprocess',
    'LTXVScheduler',
    'LoadImage',
    'SamplerCustom',
    'SaveImage',
    'SaveWEBM',
    'VAEDecode',
    'VAEEncode',
  ];
  const info: ObjectInfo = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [options.checkpoints, {}] } } },
    CLIPLoader: { input: { required: { clip_name: [options.clips, {}] } } },
  };
  for (const nodeClass of classes) {
    if (options.omit?.includes(nodeClass)) continue;
    info[nodeClass] = { input: { required: {} } };
  }
  return info;
}

const LIVE = objectInfo({
  checkpoints: ['SDXL\\sd_xl_base_1.0.safetensors', 'hunyuan_video_720p_fp8_e4m3fn.safetensors'],
  // Verbatim from the real backend: nothing installed for CLIPLoader at all.
  clips: [],
});

const base = {
  info: LIVE,
  backendId: null,
  backendName: 'desktop-6900xt',
  installed: false,
};

describe('folderForSavePath', () => {
  it('takes the first segment: a subfolder is still inside the folder a loader reads', () => {
    expect(folderForSavePath('checkpoints/LTXV', 'checkpoint')).toBe('checkpoints');
    expect(folderForSavePath('diffusion_models/FLUX1', 'checkpoint')).toBe('diffusion_models');
  });

  it('falls back to the folder the type implies for "default"', () => {
    expect(folderForSavePath('default', 'upscaler')).toBe('upscale_models');
    expect(folderForSavePath(null, 'clip')).toBe('text_encoders');
  });

  it('maps the legacy "unet" spelling onto diffusion_models', () => {
    expect(folderForSavePath('unet', 'checkpoint')).toBe('diffusion_models');
  });
});

describe('runnabilityFor', () => {
  it('calls a LoRA a support file rather than judging it unrunnable', () => {
    const verdict = runnabilityFor({
      ...base,
      filename: 'lcm-lora-sdxl.safetensors',
      type: 'lora',
      catalogueBase: 'SDXL',
      folder: 'loras',
    });
    expect(verdict.status).toBe('support');
    expect(verdict.detail).toContain('Adapts a checkpoint');
    expect(isUsable(verdict.status)).toBe(false);
  });

  it('says outright that a family with no template will not become usable', () => {
    const verdict = runnabilityFor({
      ...base,
      filename: 'svd_xt.safetensors',
      type: 'checkpoint',
      catalogueBase: 'SVD',
      folder: 'checkpoints',
    });
    expect(verdict.status).toBe('no-workflow');
    expect(verdict.family).toBe('svd');
    expect(verdict.detail).toContain('Stable Video Diffusion');
    expect(verdict.capabilities).toEqual([]);
  });

  it('names the companion model an LTX-Video checkpoint needs, and what it is for', () => {
    const verdict = runnabilityFor({
      ...base,
      filename: 'ltx-video-2b-v0.9.1.safetensors',
      type: 'checkpoint',
      catalogueBase: 'LTXV',
      folder: 'checkpoints',
    });
    expect(verdict.status).toBe('needs-companion');
    expect(verdict.missing[0]).toMatchObject({
      filename: 't5xxl_fp16.safetensors',
      purpose: 'T5 text encoder',
      loader: 'CLIPLoader',
    });
    expect(verdict.detail).toContain('T5 text encoder');
    // The capabilities it *would* have, so the card can say what is being lost.
    expect(verdict.capabilities).toContain('txt2vid');
  });

  it('catches a file that would install where the workflow cannot read it', () => {
    const verdict = runnabilityFor({
      ...base,
      filename: 'flux1-dev.safetensors',
      type: 'checkpoint',
      catalogueBase: 'SD1.x',
      // The FLUX family is excluded from the generic graph, so use a file the
      // fallback does claim: what is wrong here is only the folder.
      folder: 'diffusion_models',
    });
    expect(verdict.status).toBe('wrong-folder');
    // Names both folders, which is the whole remedy — and says nothing about
    // node classes, which mean nothing to the person reading the card.
    expect(verdict.detail).toContain('diffusion_models');
    expect(verdict.detail).toContain('checkpoints');
  });

  it('reports an installed file its own loader cannot see as needing a move, not a download', () => {
    const verdict = runnabilityFor({
      ...base,
      installed: true,
      // On the box, but filed under diffusion_models where CheckpointLoader
      // cannot reach it — so /object_info does not offer it.
      filename: 'ltx-video-2b-v0.9.1.safetensors',
      type: 'checkpoint',
      catalogueBase: 'LTXV',
      folder: null,
    });
    expect(verdict.status).toBe('wrong-folder');
    expect(verdict.summary).toBe('On disk, but the workflow cannot see it');
    expect(verdict.detail).toContain('needs moving, not downloading again');
  });

  it('is happy about an SDXL checkpoint the backend already offers', () => {
    const verdict = runnabilityFor({
      ...base,
      installed: true,
      filename: 'SDXL\\sd_xl_base_1.0.safetensors',
      type: 'checkpoint',
      catalogueBase: 'SDXL',
      folder: null,
    });
    expect(verdict.status).toBe('ready');
    expect(verdict.capabilities).toEqual(expect.arrayContaining(['txt2img', 'img2img']));
    expect(isUsable(verdict.status)).toBe(true);
  });

  it('flags the generic graph as generic rather than passing it off as a real template', () => {
    const verdict = runnabilityFor({
      ...base,
      filename: 'some_merge_nobody_has_heard_of.safetensors',
      type: 'checkpoint',
      catalogueBase: null,
      folder: 'checkpoints',
    });
    expect(verdict.status).toBe('generic');
    expect(verdict.family).toBeNull();
    // What it will do, not what we failed to work out. The old caption here
    // read "We could not work out what family this is…", which explained our
    // inference to somebody who only wanted to know whether to download it.
    expect(verdict.detail).toBe(
      'Runs on the generic Stable Diffusion workflow — text-to-image and image-to-image.',
    );
    expect(verdict.detail).not.toMatch(/could not work out|we /i);
  });

  it('degrades to "cannot tell" instead of guessing when the backend is unreadable', () => {
    const verdict = runnabilityFor({
      ...base,
      info: null,
      filename: 'ltx-video-2b-v0.9.1.safetensors',
      type: 'checkpoint',
      catalogueBase: 'LTXV',
      folder: 'checkpoints',
    });
    expect(verdict.status).toBe('unknown');
    expect(verdict.detail).toContain('could not check');
  });

  it('still answers the static questions with no backend at all', () => {
    // No /object_info, but a save path is enough to know this can never load.
    const verdict = runnabilityFor({
      ...base,
      info: null,
      filename: 'wan2.1_t2v_14B_fp16.safetensors',
      type: 'checkpoint',
      catalogueBase: 'SD1.x',
      folder: 'diffusion_models',
    });
    expect(verdict.status).toBe('wrong-folder');
  });

  it('says a missing custom node is a node, not a file to download', () => {
    const verdict = runnabilityFor({
      ...base,
      filename: 'ltx-video-2b-v0.9.1.safetensors',
      type: 'checkpoint',
      catalogueBase: 'LTXV',
      folder: 'checkpoints',
      info: objectInfo({
        checkpoints: ['ltx-video-2b-v0.9.1.safetensors'],
        clips: ['t5xxl_fp16.safetensors'],
        omit: ['SaveWEBM'],
      }),
    });
    expect(verdict.status).toBe('needs-companion');
    expect(verdict.summary).toBe('Needs a custom node');
    expect(verdict.detail).toContain('SaveWEBM');
  });

  it('is satisfied once the companion encoder is installed', () => {
    const verdict = runnabilityFor({
      ...base,
      filename: 'ltx-video-2b-v0.9.1.safetensors',
      type: 'checkpoint',
      catalogueBase: 'LTXV',
      folder: 'checkpoints',
      info: objectInfo({
        checkpoints: ['ltx-video-2b-v0.9.1.safetensors'],
        clips: ['t5xxl_fp16.safetensors'],
      }),
    });
    expect(verdict.status).toBe('ready');
    expect(verdict.capabilities).toEqual(expect.arrayContaining(['txt2vid', 'img2vid']));
  });

  // ------------------------------------------------------------------------
  // The catalogue states a family for every row. Believing it is the whole
  // fix: on the live 372-entry catalogue, 19 checkpoints whose own row said
  // Stable Cascade, SUPIR, Hunyuan-DiT, PixArt, OmniGen2 (and five others)
  // were being offered the generic Stable-Diffusion graph and captioned "we
  // could not work out what family this is". None of them would have run.

  it('believes a family it has never heard of rather than calling it unknown', () => {
    const verdict = runnabilityFor({
      ...base,
      filename: 'stable_cascade_stage_b.safetensors',
      type: 'checkpoint',
      catalogueBase: 'Stable Cascade',
      folder: 'checkpoints',
    });
    expect(verdict.status).toBe('no-workflow');
    // The model's own word for itself, not ours.
    expect(verdict.detail).toBe('No Stable Cascade workflow yet — this studio cannot generate with one.');
    expect(verdict.detail).not.toMatch(/could not work out/i);
  });

  it('lets a stated family overrule a filename that merely looks familiar', () => {
    // "ltx-2-19b-dev" contains "ltx", so the filename rules place it in the
    // LTX-Video family — a different generation with a different node set. The
    // row says LTX-2, and we have no LTX-2 graph.
    const verdict = runnabilityFor({
      ...base,
      filename: 'ltx-2-19b-dev-fp8.safetensors',
      type: 'checkpoint',
      catalogueBase: 'LTX-2',
      folder: 'checkpoints',
    });
    expect(verdict.status).toBe('no-workflow');
    expect(verdict.detail).toContain('LTX-2');
  });

  it('still guesses for an installed model with no stated family at all', () => {
    // The veto above must not reach the installed list, where a null base is
    // an ordinary community merge and the generic graph is the right answer.
    const verdict = runnabilityFor({
      ...base,
      installed: true,
      filename: 'someones_merge_v3.safetensors',
      type: 'checkpoint',
      catalogueBase: null,
      folder: null,
      info: objectInfo({ checkpoints: ['someones_merge_v3.safetensors'], clips: [] }),
    });
    expect(verdict.status).toBe('generic');
  });

  it('does not accuse the backend of hiding a file it lists under a subfolder', () => {
    // A catalogue row names `sd_xl_base_1.0.safetensors`; ComfyUI, having put
    // it in checkpoints/SDXL, lists `SDXL\\sd_xl_base_1.0.safetensors`. Matching
    // those exactly reported the one working checkpoint on the box as invisible.
    const verdict = runnabilityFor({
      ...base,
      installed: true,
      filename: 'sd_xl_base_1.0.safetensors',
      type: 'checkpoint',
      catalogueBase: 'SDXL',
      folder: 'checkpoints',
    });
    expect(verdict.status).toBe('ready');
  });

  it('keeps every caption short enough to read whole', () => {
    // The card clamps nothing, so a caption that runs long simply makes one
    // card taller than its neighbours. 160 characters is about three lines.
    const captions = [
      runnabilityFor({ ...base, filename: 'a.safetensors', type: 'lora', catalogueBase: 'SDXL', folder: 'loras' }),
      runnabilityFor({ ...base, filename: 'svd_xt.safetensors', type: 'checkpoint', catalogueBase: 'SVD', folder: 'checkpoints' }),
      runnabilityFor({ ...base, filename: 'ltx-video-2b-v0.9.1.safetensors', type: 'checkpoint', catalogueBase: 'LTXV', folder: 'checkpoints' }),
      runnabilityFor({ ...base, filename: 'x.safetensors', type: 'checkpoint', catalogueBase: 'SD1.x', folder: 'diffusion_models' }),
      runnabilityFor({ ...base, filename: 'SDXL\\sd_xl_base_1.0.safetensors', type: 'checkpoint', catalogueBase: 'SDXL', folder: null, installed: true }),
    ];
    for (const verdict of captions) {
      expect(verdict.detail!.length).toBeLessThanOrEqual(160);
      expect(verdict.detail).not.toMatch(/could not work out what family/i);
    }
  });
});
