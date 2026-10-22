import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@comfy/shared';
import { compareBest, inScope, sortCatalogue } from './discover';
import { companionName, intentsOf, verdictLabel, worksHere } from './intents';
import { isRecommendedHere, recommendationFor } from './recommended';
import { makeEntry, makeInfo, makeRunnability } from './testing';

function model(name: string, overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return makeEntry({
    ref: name,
    name,
    filename: `${name}.safetensors`,
    type: 'checkpoint',
    base: 'SDXL',
    reference: null,
    runnability: makeRunnability({ status: 'ready', capabilities: ['txt2img', 'img2img'] }),
    ...overrides,
  });
}

const tasks = (task: string[]) =>
  makeInfo({ tags: { task, version: [], base: [], library: [], format: [], language: [], license: [], tag: [] } });

describe('intentsOf', () => {
  it('reads capabilities first', () => {
    expect([...intentsOf(model('sdxl'))].sort()).toEqual(['edit', 'images']);
    const ltx = model('ltx', { runnability: makeRunnability({ status: 'ready', capabilities: ['txt2vid', 'img2vid'] }) });
    expect([...intentsOf(ltx)]).toEqual(['video']);
  });

  it('falls back to task tags, and to images for a model nobody described', () => {
    const noVerdict = { runnability: null };
    expect([...intentsOf(model('wan', { ...noVerdict, info: tasks(['text-to-video']) }))]).toEqual(['video']);
    expect([...intentsOf(model('kontext', { ...noVerdict, info: tasks(['image-to-image']) }))].sort()).toEqual([
      'edit',
      'images',
    ]);
    expect([...intentsOf(model('bare', noVerdict))]).toEqual(['images']);
  });

  it('files add-ons and enlargers by type, whatever their tags say', () => {
    const lora = model('lora', { type: 'lora', info: tasks(['text-to-image']), runnability: makeRunnability() });
    expect([...intentsOf(lora)]).toEqual(['styles']);
    expect([...intentsOf(makeEntry())]).toEqual(['enlarge']);
    expect(intentsOf(model('vae', { type: 'vae', runnability: makeRunnability() })).size).toBe(0);
  });
});

describe('the Discover scope', () => {
  const scope = { intent: 'all' as const, type: null, runs: false };

  it('leaves parts out unless the type filter names one', () => {
    const vae = model('ae', { type: 'vae', runnability: makeRunnability() });
    expect(inScope(vae, scope)).toBe(false);
    expect(inScope(vae, { ...scope, type: 'vae' })).toBe(true);
    expect(inScope(model('sdxl'), scope)).toBe(true);
  });

  it('counts a model that needs one more file as working, and add-ons as never failing', () => {
    expect(worksHere(model('a', { runnability: makeRunnability({ status: 'needs-companion' }) }))).toBe(true);
    expect(worksHere(model('b', { runnability: makeRunnability({ status: 'no-workflow' }) }))).toBe(false);
    expect(worksHere(model('c', { runnability: null }))).toBe(false);
    expect(worksHere(makeEntry())).toBe(true);
  });
});

describe('the default sort', () => {
  it('puts recommended, then installable, then by verdict, then by downloads', () => {
    const entries = [
      model('blocked', { installBlockedReason: 'Discovery only', info: makeInfo({ downloads: 9e6 }) }),
      model('broken', { runnability: makeRunnability({ status: 'no-workflow' }), info: makeInfo({ downloads: 8e6 }) }),
      model('needs', { runnability: makeRunnability({ status: 'needs-companion' }), info: makeInfo({ downloads: 7e6 }) }),
      model('generic', { runnability: makeRunnability({ status: 'generic' }), info: makeInfo({ downloads: 6e6 }) }),
      model('popular', { info: makeInfo({ downloads: 5e6 }) }),
      model('quiet', { info: makeInfo({ downloads: 10 }) }),
      model('juggernautXL_v9', { info: makeInfo({ downloads: 1 }) }),
    ];
    expect(sortCatalogue(entries, 'best').map((e) => e.ref)).toEqual([
      'juggernautXL_v9',
      'popular',
      'quiet',
      'generic',
      'needs',
      'broken',
      'blocked',
    ]);
    expect(compareBest(entries[0]!, entries[0]!)).toBe(0);
  });
});

describe('recommended', () => {
  it('matches the curated models by name or filename', () => {
    const label = (overrides: Partial<ModelCatalogEntry>) => recommendationFor(model('x', overrides))?.label ?? null;
    expect(label({ name: 'SDXL Base 1.0', filename: 'sd_xl_base_1.0.safetensors' })).toBe('SDXL base');
    expect(label({ name: 'DreamShaper XL Turbo' })).toBe('DreamShaper XL');
    expect(label({ filename: 'sdxl_lightning_4step.safetensors' })).toBe('SDXL Lightning');
    expect(label({ name: 'FLUX.1 [schnell]', filename: 'flux1-schnell.safetensors' })).toBe('FLUX.1 schnell');
    expect(label({ filename: 'ltx-video-2b-v0.9.safetensors' })).toBe('LTX-Video');
    expect(label({ filename: 'wan2.2_ti2v_5B_fp16.safetensors' })).toBe('Wan 2.2 TI2V 5B');
    expect(label({ name: 'Some SDXL merge', filename: 'merge.safetensors' })).toBeNull();
    expect(recommendationFor(makeEntry())?.label).toBe('RealESRGAN');
    expect(recommendationFor(makeEntry({ name: '4x-UltraSharp', filename: '4x-UltraSharp.pth' }))?.label).toBe(
      '4x-UltraSharp',
    );
  });

  it('is not the wrong type, and never a pattern match on an add-on', () => {
    expect(recommendationFor(model('juggernaut-xl-style', { type: 'lora' }))).toBeNull();
  });

  it('badges only what will work here', () => {
    expect(isRecommendedHere(model('juggernaut_xl'))).toBe(true);
    expect(isRecommendedHere(model('juggernaut_xl', { installBlockedReason: 'Discovery only' }))).toBe(false);
    expect(
      isRecommendedHere(model('juggernaut_xl', { runnability: makeRunnability({ status: 'needs-companion' }) })),
    ).toBe(false);
    expect(isRecommendedHere(makeEntry())).toBe(true);
  });
});

describe('missing parts', () => {
  it('names them in plain words', () => {
    expect(companionName({ filename: 'umt5_xxl.safetensors', purpose: 'T5 text encoder', loader: 'CLIPLoader' })).toBe(
      'Prompt reader',
    );
    expect(companionName({ filename: 'ae.safetensors', purpose: null, loader: 'VAELoader' })).toBe('Image decoder');
    expect(companionName({ filename: 'x.bin', purpose: 'Motion module', loader: 'Foo' })).toBe('Motion module');
    const entry = model('flux', {
      runnability: makeRunnability({
        status: 'needs-companion',
        missing: [
          { filename: 'clip_l.safetensors', purpose: null, loader: 'DualCLIPLoader' },
          { filename: 't5xxl.safetensors', purpose: null, loader: 'DualCLIPLoader' },
        ],
      }),
    });
    // Both text encoders are one "prompt reader", named once.
    expect(verdictLabel(entry.runnability!)).toBe('Needs prompt reader');
    expect(
      verdictLabel({
        status: 'needs-companion',
        missing: [
          { filename: 't5xxl.safetensors', purpose: null, loader: 'CLIPLoader' },
          { filename: 'ae.safetensors', purpose: null, loader: 'VAELoader' },
        ],
      }),
    ).toBe('Needs prompt reader and image decoder');
    expect(verdictLabel({ status: 'ready' })).toBe('Will run');
  });
});
