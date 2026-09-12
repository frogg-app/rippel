/**
 * The hand-download table, held to its sources.
 *
 * The table exists because the reference machine lost its install catalogue.
 * Its failure mode is a stale or mistyped URL that a person follows by hand —
 * which fails as the wrong file, not as an error. So every row that claims to
 * come from the library is checked against the real library file, and the card
 * verdict is checked to carry the row a person actually needs.
 */

import { describe, expect, it } from 'vitest';
import type { ObjectInfo } from '../lib/comfy.js';
import libraryFile from './__fixtures__/library-template-wan22-5b.json' with { type: 'json' };
import { libraryModelsOf, parseLibraryTemplate } from '../workflows/library/litegraph.js';
import { KNOWN_DOWNLOADS, knownDownloadFor } from './known-downloads.js';
import { runnabilityFor } from './runnability.js';

describe('KNOWN_DOWNLOADS', () => {
  it('matches the library file exactly for every row that cites it', () => {
    const library = libraryModelsOf(parseLibraryTemplate(libraryFile));
    const cited = KNOWN_DOWNLOADS.filter((row) => row.origin.includes('video_wan2_2_5B_ti2v'));
    expect(cited).toHaveLength(library.length);
    for (const row of cited) {
      const entry = library.find((m) => m.filename === row.filename);
      expect(entry, row.filename).toBeDefined();
      expect({ folder: row.folder, url: row.url }).toEqual({ folder: entry!.folder, url: entry!.url });
    }
  });

  it('only lists HTTPS Hugging Face or Civitai URLs', () => {
    for (const row of KNOWN_DOWNLOADS) expect(row.url).toMatch(/^https:\/\/(huggingface\.co|civitai\.com)\//);
  });

  it('finds a file however ComfyUI spells its path', () => {
    // Windows backends report subfolders with backslashes.
    expect(knownDownloadFor('Wan\\WAN2.2_VAE.safetensors')?.folder).toBe('vae');
    expect(knownDownloadFor('wan_2.1_vae.safetensors')).toBeNull();
  });
});

describe('a needs-another-model verdict says where to get the file', () => {
  const info = (): ObjectInfo => {
    const classes = ['CLIPTextEncode', 'KSampler', 'ModelSamplingSD3', 'LoadImage', 'Wan22ImageToVideoLatent', 'VAEDecode', 'CreateVideo', 'SaveVideo'];
    const out: ObjectInfo = {
      UNETLoader: { input: { required: { unet_name: [['wan2.2_ti2v_5B_fp16.safetensors'], {}] } } },
      CLIPLoader: { input: { required: { clip_name: [[], {}] } } },
      VAELoader: { input: { required: { vae_name: [['pixel_space'], {}] } } },
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [[], {}] } } },
    };
    for (const c of classes) out[c] = { input: { required: {} } };
    return out;
  };

  it('attaches folder, URL and size to each missing Wan companion', () => {
    // The reference box today: Manager gone, so this is the only place the
    // card can learn that the encoder lives on Comfy-Org's 2.1 repo while the
    // VAE lives on the 2.2 one.
    const verdict = runnabilityFor({
      filename: 'wan2.2_ti2v_5B_fp16.safetensors',
      type: 'checkpoint',
      catalogueBase: null,
      folder: 'diffusion_models',
      info: info(),
      backendId: null,
      backendName: 'desktop-6900xt',
      installed: true,
    });
    expect(verdict.status).toBe('needs-companion');
    const byLoader = Object.fromEntries(verdict.missing.map((m) => [m.loader, m.source]));
    expect(byLoader.CLIPLoader).toMatchObject({ folder: 'text_encoders', approxBytes: 6_270_000_000 });
    expect(byLoader.VAELoader?.url).toContain('Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors');
  });
});
