/**
 * Preflight, checked against the payload shapes a real backend produces.
 *
 * The `/object_info` fragments below are copied verbatim from ComfyUI 0.34.0 at
 * 192.168.1.10:8188 (2026-09-06), including the Windows path separator and the
 * empty `clip_name` list that makes an LTX-Video job impossible on that box.
 * Paraphrasing them would test our idea of the format rather than the format.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObjectInfo } from '../lib/comfy.js';
import type { ComfyApiGraph } from '../workflows/types.js';
import { checkGraph, clearObjectInfoCache, explain, objectInfoFor, preflight } from './preflight.js';

const INFO: ObjectInfo = {
  CheckpointLoaderSimple: {
    input: {
      required: {
        ckpt_name: [
          ['SDXL\\sd_xl_base_1.0.safetensors', 'hunyuan_video_720p_fp8_e4m3fn.safetensors'],
          { tooltip: 'The name of the checkpoint (model) to load.' },
        ],
      },
    },
  },
  // The live server reports this as an empty list: no text encoders installed.
  CLIPLoader: { input: { required: { clip_name: [[]], type: [['stable_diffusion', 'ltxv']] } } },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }] } } },
  KSampler: {
    input: {
      required: {
        seed: ['INT', {}],
        sampler_name: [['euler', 'dpmpp_2m'], {}],
        scheduler: [['normal', 'karras'], {}],
      },
    },
  },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: { filename_prefix: ['STRING', {}] } } },
  // Verbatim: LoadImage's combo lists only the top level of input/.
  LoadImage: { input: { required: { image: [['example.png', 'probe.png'], { image_upload: true }] } } },
  LoraLoader: {
    input: { required: { lora_name: ['COMBO', { options: ['detail-tweaker.safetensors'] }] } },
  },
};

const graph = (nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }>) =>
  nodes as unknown as ComfyApiGraph;

const SDXL = graph({
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'SDXL\\sd_xl_base_1.0.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '3': { class_type: 'KSampler', inputs: { seed: 1, sampler_name: 'dpmpp_2m', scheduler: 'karras' } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'comfy-studio/txt2img' } },
});

describe('checkGraph', () => {
  it('passes a graph whose every file the backend offers', () => {
    expect(checkGraph(SDXL, INFO)).toEqual({ missingFiles: [], missingNodeClasses: [] });
  });

  it('catches the checkpoint ComfyUI would reject at /prompt', () => {
    const result = checkGraph(
      graph({ '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ltx-video-2b-v0.9.1.safetensors' } } }),
      INFO,
    );
    expect(result.missingFiles).toHaveLength(1);
    expect(result.missingFiles[0]?.filename).toBe('ltx-video-2b-v0.9.1.safetensors');
  });

  it('catches a text encoder whose loader has nothing installed at all', () => {
    // The LTX-Video case: `Value not in list: clip_name: 't5xxl_fp16.safetensors'
    // not in []`. An empty combo is a combo, not an unchecked input.
    const result = checkGraph(
      graph({ '12': { class_type: 'CLIPLoader', inputs: { clip_name: 't5xxl_fp16.safetensors', type: 'ltxv' } } }),
      INFO,
    );
    expect(result.missingFiles[0]?.available).toEqual([]);
    expect(explain(result, 'desktop-6900xt')).toContain('T5 text encoder');
    expect(explain(result, 'desktop-6900xt')).toContain('desktop-6900xt');
  });

  it('does not reject an img2img graph, whose LoadImage names a file uploaded at dispatch', () => {
    // This is the regression that matters most: the file is genuinely absent
    // from LoadImage's combo list and the job runs anyway, because the node
    // validates the path itself. Rejecting here would break every img2img job.
    const result = checkGraph(
      graph({
        '10': { class_type: 'LoadImage', inputs: { image: 'comfy-studio/9f2ab1.png' } },
        '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'SDXL\\sd_xl_base_1.0.safetensors' } },
      }),
      INFO,
    );
    expect(result.missingFiles).toEqual([]);
  });

  it('ignores literals that are not files: samplers, schedulers, prompts, prefixes', () => {
    const result = checkGraph(
      graph({
        '3': { class_type: 'KSampler', inputs: { sampler_name: 'euler', scheduler: 'karras' } },
        // A prompt that happens to mention a filename is still a prompt.
        '6': { class_type: 'CLIPTextEncode', inputs: { text: 'in the style of foo.safetensors' } },
        '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'comfy-studio/txt2img' } },
      }),
      INFO,
    );
    expect(result.missingFiles).toEqual([]);
  });

  it('reads the newer COMBO shape as well as the legacy one', () => {
    const missing = checkGraph(
      graph({ '20': { class_type: 'LoraLoader', inputs: { lora_name: 'nope.safetensors' } } }),
      INFO,
    ).missingFiles;
    expect(missing[0]?.available).toEqual(['detail-tweaker.safetensors']);

    const ok = checkGraph(
      graph({ '20': { class_type: 'LoraLoader', inputs: { lora_name: 'detail-tweaker.safetensors' } } }),
      INFO,
    ).missingFiles;
    expect(ok).toEqual([]);
  });

  it('treats a separator or case difference as the same file, not a missing one', () => {
    // The fleet reports Windows paths; a false rejection here would refuse a
    // job that would have run, which is worse than the bug being fixed.
    const result = checkGraph(
      graph({ '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'SDXL/SD_XL_Base_1.0.safetensors' } } }),
      INFO,
    );
    expect(result.missingFiles).toEqual([]);
  });

  it('reports a node class the backend has never heard of', () => {
    const result = checkGraph(
      graph({ '1': { class_type: 'LTXVConditioning', inputs: { frame_rate: 25 } } }),
      INFO,
    );
    expect(result.missingNodeClasses).toEqual(['LTXVConditioning']);
    expect(explain(result, 'desktop-6900xt')).toContain('custom node');
  });
});

describe('explain', () => {
  it('says when the file is present but the wrong loader can see it', () => {
    // The live LTX case: the weights are on the disk under a folder
    // CheckpointLoaderSimple does not read. Telling the user to download it
    // again would be wrong, and this is the difference.
    const info: ObjectInfo = {
      ...INFO,
      UNETLoader: {
        input: { required: { unet_name: [['ltx-video-2b-v0.9.1.safetensors'], {}] } },
      },
    };
    const result = checkGraph(
      graph({ '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ltx-video-2b-v0.9.1.safetensors' } } }),
      info,
    );
    const message = explain(result, 'desktop-6900xt', info);
    expect(message).toContain('UNETLoader');
    expect(message).toContain('needs moving');
  });

  it('mentions the other missing files rather than only the first', () => {
    const result = checkGraph(
      graph({
        '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ltx-video-2b-v0.9.1.safetensors' } },
        '12': { class_type: 'CLIPLoader', inputs: { clip_name: 't5xxl_fp16.safetensors' } },
      }),
      INFO,
    );
    expect(explain(result, 'desktop-6900xt', INFO)).toContain('T5 text encoder');
  });
});

describe('objectInfoFor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearObjectInfoCache();
  });

  it('fetches once per backend and serves the rest from cache', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(INFO), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    // Concurrent callers share the in-flight promise, which is the case that
    // matters: /object_info is a megabyte and the Create screen is bursty.
    await Promise.all([objectInfoFor('http://a:8188'), objectInfoFor('http://a:8188')]);
    await objectInfoFor('http://a:8188');
    await objectInfoFor('http://b:8188');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure, and lets the job through when it cannot ask', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    // Fail open: a flaky poll must not become "you may not generate".
    expect(await preflight(SDXL, { name: 'desktop', base_url: 'http://a:8188' })).toBeNull();
    expect(await preflight(SDXL, { name: 'desktop', base_url: 'http://a:8188' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
