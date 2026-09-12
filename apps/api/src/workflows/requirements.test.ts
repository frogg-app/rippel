/**
 * Companion-model requirements: do they address real inputs, and does
 * resolution pick the file a real backend actually has?
 *
 * The `/object_info` fragments below are not invented. They are what
 * http://192.168.1.10:8188 returns today, trimmed to the nodes under test —
 * including the empty `clip_name` option list, which is the exact shape that
 * made the LTX-Video templates unrunnable and is the reason this module exists.
 */

import { describe, expect, it } from 'vitest';

import type { ObjectInfo } from '../lib/comfy.js';
import {
  LTXV_TEXT_ENCODER_REQUIREMENT,
  TEMPLATES,
  img2vidLtxvTemplate,
  rankCandidates,
  requirementSite,
  resolveRequirements,
  txt2vidLtxvTemplate,
  withResolvedRequirements,
} from './index.js';

/** The live box, verbatim: two checkpoints, and not one text encoder. */
const LIVE_INFO: ObjectInfo = {
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
  CLIPLoader: {
    input: { required: { clip_name: [[], {}], type: [['stable_diffusion', 'ltxv'], {}] } },
  },
};

/** The same box after somebody installs a T5 through ComfyUI-Manager. */
function infoWithEncoders(...files: string[]): ObjectInfo {
  return {
    ...LIVE_INFO,
    CLIPLoader: {
      input: { required: { clip_name: [files, {}], type: [['ltxv'], {}] } },
    },
  };
}

describe('manifest requirements', () => {
  it('every requirement path lands on an input that exists on that node', () => {
    for (const template of TEMPLATES) {
      for (const requirement of template.manifest.requires ?? []) {
        const site = requirementSite(template.graph, requirement);
        expect(site, `${template.manifest.id}: ${requirement.path}`).toBeDefined();
        // A requirement fills a literal, never a link to another node.
        expect(site!.literal, `${template.manifest.id}: ${requirement.path}`).toBeTypeOf('string');
      }
    }
  });

  it('requirement ids are unique within a manifest', () => {
    for (const template of TEMPLATES) {
      const ids = (template.manifest.requires ?? []).map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('both LTX-Video templates declare the same text encoder requirement', () => {
    expect(txt2vidLtxvTemplate.manifest.requires).toContain(LTXV_TEXT_ENCODER_REQUIREMENT);
    expect(img2vidLtxvTemplate.manifest.requires).toContain(LTXV_TEXT_ENCODER_REQUIREMENT);
  });

  it('the SD/SDXL templates declare none — their checkpoints carry everything', () => {
    for (const template of TEMPLATES) {
      if (template.manifest.capability.endsWith('vid')) continue;
      expect(template.manifest.requires ?? []).toHaveLength(0);
    }
  });
});

describe('resolveRequirements', () => {
  it('reports nothing available when the backend has no text encoder at all', () => {
    const [resolved] = resolveRequirements(txt2vidLtxvTemplate, LIVE_INFO);
    expect(resolved).toBeDefined();
    // An empty combo, not a missing one: the loader exists, it just has no files.
    expect(resolved!.available).toEqual([]);
    expect(resolved!.filename).toBeNull();
  });

  it('finds a T5 filed in a subfolder, which a literal filename never would', () => {
    const info = infoWithEncoders('t5\\t5xxl_fp8_e4m3fn.safetensors');
    const [resolved] = resolveRequirements(txt2vidLtxvTemplate, info);
    // The graph literal is `t5xxl_fp16.safetensors`; the box has neither that
    // name nor that path. This is the case the whole mechanism exists for.
    expect(resolved!.filename).toBe('t5\\t5xxl_fp8_e4m3fn.safetensors');
  });

  it('prefers an fp8 build over fp16 when a backend has several', () => {
    // Deliberately the smaller build, not the better one. Note the reason is
    // download size and cache churn, not "fp16 overflows the card" — the
    // encoder and the transformer are never resident together. See the note on
    // the requirement's `preferred` list.
    const info = infoWithEncoders(
      't5/t5xxl_fp8_e4m3fn.safetensors',
      't5/t5xxl_fp16.safetensors',
      'clip_l.safetensors',
    );
    const [resolved] = resolveRequirements(txt2vidLtxvTemplate, info);
    expect(resolved!.filename).toBe('t5/t5xxl_fp8_e4m3fn.safetensors');
    // `clip_l` is a text encoder but not a T5, so it is not a candidate.
    expect(resolved!.candidates).not.toContain('clip_l.safetensors');
  });

  it('prefers the scaled fp8 over the plain one', () => {
    // Same size class; the scaled build keeps per-tensor scales.
    const info = infoWithEncoders(
      't5/t5xxl_fp8_e4m3fn.safetensors',
      't5/t5xxl_fp8_e4m3fn_scaled.safetensors',
    );
    const [resolved] = resolveRequirements(txt2vidLtxvTemplate, info);
    expect(resolved!.filename).toBe('t5/t5xxl_fp8_e4m3fn_scaled.safetensors');
  });

  it('is stable: the same backend resolves to the same file every time', () => {
    const files = ['t5/b_t5xxl_x.safetensors', 't5/a_t5xxl_y.safetensors'];
    const first = resolveRequirements(txt2vidLtxvTemplate, infoWithEncoders(...files));
    const second = resolveRequirements(txt2vidLtxvTemplate, infoWithEncoders(...[...files].reverse()));
    expect(first[0]!.filename).toBe(second[0]!.filename);
  });

  it('ranks a preferred file first regardless of its subfolder', () => {
    // The subject is the folder being ignored, not which build wins: the
    // deeper path holds the *more* preferred file and still comes first.
    const ranked = rankCandidates(LTXV_TEXT_ENCODER_REQUIREMENT, [
      'sub/t5xxl_fp16.safetensors',
      'nested/deep/t5xxl_fp8_e4m3fn.safetensors',
    ]);
    expect(ranked[0]).toBe('nested/deep/t5xxl_fp8_e4m3fn.safetensors');
  });
});

describe('withResolvedRequirements', () => {
  it('writes the backend’s own T5 into the graph', () => {
    const info = infoWithEncoders('t5/t5xxl_fp8_e4m3fn_scaled.safetensors');
    const graph = withResolvedRequirements(txt2vidLtxvTemplate.graph, txt2vidLtxvTemplate, info);
    expect(graph['12']!.inputs.clip_name).toBe('t5/t5xxl_fp8_e4m3fn_scaled.safetensors');
    // And the template itself is untouched — it is shared by every job.
    expect(txt2vidLtxvTemplate.graph['12']!.inputs.clip_name).toBe('t5xxl_fp16.safetensors');
  });

  it('leaves the literal alone when nothing matches, so preflight can explain', () => {
    const graph = withResolvedRequirements(txt2vidLtxvTemplate.graph, txt2vidLtxvTemplate, LIVE_INFO);
    expect(graph['12']!.inputs.clip_name).toBe('t5xxl_fp16.safetensors');
    expect(graph).toBe(txt2vidLtxvTemplate.graph);
  });

  it('does not disturb the rest of the graph', () => {
    const info = infoWithEncoders('t5/t5xxl_fp16.safetensors');
    const graph = withResolvedRequirements(img2vidLtxvTemplate.graph, img2vidLtxvTemplate, info);
    expect(Object.keys(graph).sort()).toEqual(Object.keys(img2vidLtxvTemplate.graph).sort());
    expect(graph['3']!.inputs).toEqual(img2vidLtxvTemplate.graph['3']!.inputs);
    expect(graph['12']!.inputs.type).toBe('ltxv');
  });
});
