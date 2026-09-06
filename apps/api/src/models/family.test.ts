/**
 * Tests for base-model family inference.
 *
 * Two things are being pinned down here. The first is the inference table
 * itself, including the cases that made the rules the shape they are: a Windows
 * subfolder, a name that claims two families, and a name that says nothing.
 * The second matters more — that what we infer is a spelling the *real*
 * workflow registry accepts, so a discovered SDXL checkpoint actually reaches
 * `txt2img-sdxl`. Asserting the families in isolation would pass happily while
 * the orchestrator found no template for any of them.
 *
 * No database is involved: inference is pure, which is exactly why it lives in
 * its own module rather than inside the poller.
 */

import { describe, expect, it } from 'vitest';
import { FAMILIES, familyFromCatalogueBase, familyFromFilename, inferFamily } from './family.js';
import { findTemplate, normalizeBaseModel } from '../workflows/registry.js';

describe('familyFromFilename', () => {
  const cases: [string, string | null][] = [
    // The real row on the test box: ComfyUI reports the subfolder, with a
    // Windows separator, and the file's own name never says "sdxl".
    ['SDXL\\sd_xl_base_1.0.safetensors', FAMILIES.sdxl],
    ['sd_xl_base_1.0.safetensors', FAMILIES.sdxl],
    ['sd_xl_refiner_1.0.safetensors', FAMILIES.sdxl],
    ['checkpoints/sdxl/juggernautXL_v9.safetensors', FAMILIES.sdxl],
    // Only the community "…XL" convention to go on, and nothing contradicting it.
    ['dreamshaperXL_turbo.safetensors', FAMILIES.sdxlTurbo],
    ['dreamshaperXL_v21.safetensors', FAMILIES.sdxl],

    // SDXL derivatives beat plain SDXL: they are more specific, not a conflict.
    ['ponyDiffusionV6XL.safetensors', FAMILIES.pony],
    ['Illustrious-XL-v0.1.safetensors', FAMILIES.illustrious],
    ['noobaiXL_vPred1.safetensors', FAMILIES.illustrious],

    ['v1-5-pruned-emaonly.safetensors', FAMILIES.sd15],
    ['SD1.5\\realisticVision_v51.safetensors', FAMILIES.sd15],
    ['sd15_inpainting.ckpt', FAMILIES.sd15],
    ['v2-1_768-ema-pruned.safetensors', FAMILIES.sd2],
    ['sd3.5_medium.safetensors', FAMILIES.sd3],

    ['flux1-dev.safetensors', FAMILIES.flux],
    ['unet/flux1-schnell-fp8.safetensors', FAMILIES.flux],

    // The two video models actually installed on the test box.
    ['hunyuan_video_720p_fp8_e4m3fn.safetensors', FAMILIES.hunyuanVideo],
    ['ltx-video-2b-v0.9.1.safetensors', FAMILIES.ltxVideo],
    ['svd_xt_1_1.safetensors', FAMILIES.svd],
    ['wan2.1_t2v_14B_fp8.safetensors', FAMILIES.wan],

    // Nothing to go on. Never guessed at.
    ['4x-UltraSharp.pth', null],
    ['model.safetensors', null],
    ['my-favourite-merge-final-v3.safetensors', null],
    // A well-known name that is not a family word we know.
    ['kolors_diffusion.safetensors', null],
  ];

  for (const [filename, expected] of cases) {
    it(`${filename} -> ${expected ?? 'null'}`, () => {
      expect(familyFromFilename(filename)).toBe(expected);
    });
  }

  it('refuses to choose when a name claims two incompatible families', () => {
    // Merge names like this are common and genuinely ambiguous: whichever we
    // picked would be wrong half the time, and a wrong family silently selects
    // a template that produces rubbish.
    expect(familyFromFilename('sd15_to_sdxl_refiner_merge.safetensors')).toBeNull();
    expect(familyFromFilename('flux_style_lora_for_sdxl.safetensors')).toBeNull();
  });

  it('lets an explicit family outvote a mere naming convention', () => {
    // "…XL" is a weak signal; "sd15" is explicit, so the file is SD 1.5 rather
    // than an unresolvable contradiction.
    expect(familyFromFilename('sd15_animeXL_mix.safetensors')).toBe(FAMILIES.sd15);
  });

  it('will not read a bare "hunyuan" as the video model', () => {
    // Hunyuan-DiT and HunyuanImage come from the same lab and share the word,
    // but need an entirely different graph.
    expect(familyFromFilename('hunyuan_dit_1.2.safetensors')).toBeNull();
    expect(familyFromFilename('hunyuan-video-t2v-720p.safetensors')).toBe(FAMILIES.hunyuanVideo);
  });

  it('ignores the file extension when matching', () => {
    // ".pt" and ".bin" must not become family words in their own right.
    expect(familyFromFilename('sdxl_vae.pt')).toBe(FAMILIES.sdxl);
    expect(familyFromFilename('pytorch_model.bin')).toBeNull();
  });
});

describe('familyFromCatalogueBase', () => {
  it('accepts the spellings ComfyUI-Manager uses, in any case or punctuation', () => {
    expect(familyFromCatalogueBase('SDXL')).toBe(FAMILIES.sdxl);
    expect(familyFromCatalogueBase('sdxl')).toBe(FAMILIES.sdxl);
    expect(familyFromCatalogueBase('SDXL 1.0')).toBe(FAMILIES.sdxl);
    expect(familyFromCatalogueBase('SD1.x')).toBe(FAMILIES.sd15);
    expect(familyFromCatalogueBase('SD2.x')).toBe(FAMILIES.sd2);
    expect(familyFromCatalogueBase('FLUX.1')).toBe(FAMILIES.flux);
    expect(familyFromCatalogueBase('LTXV')).toBe(FAMILIES.ltxVideo);
  });

  it('treats the catalogue\'s non-family buckets as no family', () => {
    // Manager files upscalers and odds and ends under these; they are not
    // families and must not end up in the UI's family filter.
    expect(familyFromCatalogueBase('upscale')).toBeNull();
    expect(familyFromCatalogueBase('etc')).toBeNull();
    expect(familyFromCatalogueBase('')).toBeNull();
    expect(familyFromCatalogueBase(null)).toBeNull();
    expect(familyFromCatalogueBase('something we have never heard of')).toBeNull();
  });
});

describe('inferFamily', () => {
  it('prefers the catalogue over the filename', () => {
    // The install record states the family outright. A misleading filename
    // (this one is genuinely called "sd_xl_…") must not override it.
    expect(
      inferFamily({ filename: 'weird-internal-name-v2.safetensors', catalogueBase: 'SDXL' }),
    ).toBe(FAMILIES.sdxl);
  });

  it('falls back to the filename when the catalogue says nothing useful', () => {
    expect(inferFamily({ filename: 'flux1-dev.safetensors', catalogueBase: 'etc' })).toBe(
      FAMILIES.flux,
    );
    expect(inferFamily({ filename: 'SDXL\\sd_xl_base_1.0.safetensors', catalogueBase: null })).toBe(
      FAMILIES.sdxl,
    );
  });

  it('is null when neither source knows', () => {
    expect(inferFamily({ filename: '4x-UltraSharp.pth', catalogueBase: 'upscale' })).toBeNull();
  });
});

/**
 * The round trip this whole module exists for. Inference that produces a family
 * string the registry does not recognise is worth nothing: the orchestrator
 * would still find no template, which is precisely the bug being fixed.
 */
describe('inferred families resolve against the real registry', () => {
  it('routes the discovered SDXL checkpoint to txt2img-sdxl', () => {
    const family = inferFamily({
      filename: 'SDXL\\sd_xl_base_1.0.safetensors',
      catalogueBase: 'SDXL',
    });
    expect(family).toBe(FAMILIES.sdxl);
    expect(findTemplate('txt2img', family)?.manifest.id).toBe('txt2img-sdxl');
  });

  it('routes SDXL derivatives to the same template', () => {
    for (const filename of ['ponyDiffusionV6XL.safetensors', 'Illustrious-XL-v0.1.safetensors']) {
      const family = familyFromFilename(filename);
      expect(findTemplate('txt2img', family)?.manifest.id).toBe('txt2img-sdxl');
    }
  });

  it('finds no template for families we have not written one for yet', () => {
    // Not a failure: a null lookup is the readable "no workflow for this yet"
    // error. It is here so that adding a template later is a visible change.
    expect(findTemplate('txt2img', familyFromFilename('flux1-dev.safetensors'))).toBeUndefined();
    expect(findTemplate('txt2img', familyFromFilename('v1-5-pruned-emaonly.safetensors')))
      .toBeUndefined();
  });

  it('spells every family it can return in one canonical form', () => {
    // Two spellings of one family would split the UI's grouping in half and
    // make the models route's filter miss rows.
    const spellings = Object.values(FAMILIES);
    const normalized = spellings.map(normalizeBaseModel);
    expect(new Set(normalized).size).toBe(spellings.length);
  });
});
