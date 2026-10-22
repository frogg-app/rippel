/** Ranking against the real official library index (fixtures from 0.11.55). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCatalogue } from '../library/workflows/catalogue.js';
import { rebindCheckpoint } from '../library/workflows/rebind.js';
import { capabilityOf, familyForEntry, rankLibraryEntries } from './workflow-suggestions.js';

const index = JSON.parse(readFileSync(new URL('../library/workflows/fixtures/index.json', import.meta.url), 'utf8'));
const { entries } = parseCatalogue(index, '0.11.55');

describe('rankLibraryEntries', () => {
  it('offers the local MiniMax H3 workflows for a MiniMax file, reference-to-video first', () => {
    const ranked = rankLibraryEntries(entries, { filename: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', family: 'minimax' });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r.entry.openSource && /minimax/i.test(r.entry.name))).toBe(true);
    expect(ranked.some((r) => r.entry.name.startsWith('api_'))).toBe(false);
    expect(ranked.map((r) => r.entry.name)).toContain('video_minimax_h3_t2v');
  });
  it('does not offer FLUX.2 or Flux.3 to a FLUX.1 file', () => {
    const ranked = rankLibraryEntries(entries, { filename: 'flux1-dev.safetensors', family: 'flux.1' });
    expect(ranked.some((r) => /flux[ ._-]?[23]/i.test(`${r.entry.name} ${r.entry.models.join(' ')}`))).toBe(false);
  });
  it('offers nothing for a file of no known family', () => {
    expect(rankLibraryEntries(entries, { filename: 'mystery.safetensors', family: null })).toEqual([]);
  });
});

describe('capabilityOf', () => {
  it('maps library tags to rippel jobs', () => {
    expect(capabilityOf({ tags: ['Text to Video'], category: 'Video' })).toBe('txt2vid');
    expect(capabilityOf({ tags: ['Reference to Video'], category: 'Video' })).toBe('img2vid');
    expect(capabilityOf({ tags: ['Motion Control'], category: 'Video' })).toBeNull();
  });
});

describe('familyForEntry', () => {
  it('folds the library model name', () => {
    expect(familyForEntry({ models: ['MiniMax H3'], title: 'x' })).toBe('minimax-h3');
  });
});

describe('rebindCheckpoint', () => {
  it('points the main loader at the installed file and stops requiring the official one', () => {
    const graph = { '1': { class_type: 'UNETLoader', inputs: { unet_name: 'official.safetensors' } } };
    const mapping = {
      manifest: { inputs: [{ path: '1.inputs.unet_name', source: 'checkpointFilename' }] },
      files: [{ name: 'official.safetensors', url: 'u', directory: 'diffusion_models', paths: ['1.inputs.unet_name'] },
        { name: 'vae.safetensors', url: 'v', directory: 'vae', paths: ['2.inputs.vae_name'] }],
      omitted: [],
    } as never;
    expect(rebindCheckpoint(graph as never, mapping, 'mine.safetensors')).toBe(true);
    expect(graph['1'].inputs.unet_name).toBe('mine.safetensors');
    expect((mapping as { files: { name: string }[] }).files.map((f) => f.name)).toEqual(['vae.safetensors']);
  });
});

describe('withLibraryFamilies', () => {
  it('adds a family only a tested import runs to the Create map', async () => {
    const { buildWorkflowCapabilities, withLibraryFamilies } = await import('../workflows/routes.js');
    const base = buildWorkflowCapabilities();
    const merged = await withLibraryFamilies(base, async () => [{ family: 'minimax', capability: 'txt2vid', id: 'w1', title: 'MiniMax H3' }]);
    expect(merged.families.find((f) => f.family === 'minimax')?.offers).toEqual([
      { capability: 'txt2vid', templateId: 'library-w1', templateLabel: 'MiniMax H3', isFallback: false },
    ]);
    expect(await withLibraryFamilies(base, async () => { throw new Error('db down'); })).toBe(base);
  });
});
