/**
 * The pure helpers, each covering something the real API taught us.
 *
 * They are cheap tests over small functions, but every one of them is a bug
 * that would be invisible in the UI: a family chip that silently matches
 * nothing, a model on disk that reads as "not installed", or a finished install
 * that stops being shown.
 */
import { describe, expect, it } from 'vitest';
import {
  basename,
  catalogueBases,
  catalogueTypes,
  elapsed,
  filterCatalogue,
  filterInstalled,
  foldFamily,
  formatCount,
  groupInstalled,
  latestByFilename,
  matchesRunFilter,
  runs,
} from './catalogue';
import { makeEntry, makeInstall, makeModel, makeRunnability } from './testing';

describe('foldFamily', () => {
  it('folds both vocabularies onto the same key', () => {
    // /api/models says "sdxl"; the catalogue says "SDXL"; the API's own
    // normalizeBaseModel folds "SDXL 1.0" and "sd-xl-1.0" together too.
    expect(foldFamily('SDXL')).toBe(foldFamily('sdxl'));
    expect(foldFamily('Hunyuan Video')).toBe(foldFamily('hunyuan-video'));
    expect(foldFamily('FLUX.1')).toBe('flux1');
  });
});

describe('basename', () => {
  it('handles the Windows subfolder the API really returns', () => {
    expect(basename('SDXL\\sd_xl_base_1.0.safetensors')).toBe('sd_xl_base_1.0.safetensors');
    expect(basename('checkpoints/foo.safetensors')).toBe('foo.safetensors');
    expect(basename('foo.safetensors')).toBe('foo.safetensors');
  });
});

describe('filterInstalled', () => {
  const models = [
    makeModel(),
    makeModel({
      id: 'b',
      type: 'lora',
      displayName: 'Film Grain',
      filename: 'film-grain.safetensors',
      baseModel: 'flux.1',
    }),
  ];

  it('matches a family whichever way it is spelled', () => {
    expect(filterInstalled(models, { type: null, family: foldFamily('SDXL'), q: '' })).toHaveLength(1);
  });

  it('searches the filename as well as the display name', () => {
    expect(filterInstalled(models, { type: null, family: null, q: 'sd_xl' })).toHaveLength(1);
  });

  it('narrows by type', () => {
    expect(filterInstalled(models, { type: 'lora', family: null, q: '' })).toHaveLength(1);
  });
});

describe('groupInstalled', () => {
  it('orders by type, then family, with the unclassified last', () => {
    const groups = groupInstalled([
      makeModel({ id: 'a', type: 'lora', baseModel: 'sdxl' }),
      makeModel({ id: 'b', type: 'checkpoint', baseModel: null }),
      makeModel({ id: 'c', type: 'checkpoint', baseModel: 'flux.1' }),
    ]);
    expect(groups.map((group) => `${group.type}/${group.family}`)).toEqual([
      'checkpoint/Flux.1',
      'checkpoint/Unclassified',
      'lora/Sdxl',
    ]);
  });
});

describe('filterCatalogue', () => {
  const entries = [
    makeEntry(),
    makeEntry({ ref: 'b', name: 'Film Grain', type: 'lora', base: 'FLUX.1', description: 'halation' }),
  ];

  it('matches the description, where the searchable words live', () => {
    expect(filterCatalogue(entries, { type: null, base: null, q: 'halation', run: 'all' })).toHaveLength(1);
  });

  it('filters on the catalogue’s own family spelling', () => {
    expect(filterCatalogue(entries, { type: null, base: 'FLUX.1', q: '', run: 'all' })).toHaveLength(1);
    // Deliberately not folded: these options come from the entries themselves.
    expect(filterCatalogue(entries, { type: null, base: 'flux1', q: '', run: 'all' })).toHaveLength(0);
  });

  it('offers only the types and families actually present', () => {
    expect(catalogueTypes(entries).map((row) => row.type)).toEqual(['lora', 'upscaler']);
    expect(catalogueBases(entries)).toEqual(['FLUX.1', 'upscale']);
  });
});

describe('latestByFilename', () => {
  it('keeps the newest install per file, whatever its state', () => {
    // Newest first, as useInstalls returns them. A completed install still
    // indexes, so a card that has just finished keeps saying so.
    const index = latestByFilename([
      makeInstall({ id: 'new', status: 'complete', filename: 'a.safetensors' }),
      makeInstall({ id: 'old', status: 'failed', filename: 'a.safetensors' }),
    ]);
    expect(index.get('a.safetensors')?.id).toBe('new');
  });

  it('indexes on the basename', () => {
    const index = latestByFilename([makeInstall({ filename: 'SDXL\\a.safetensors' })]);
    expect(index.has('a.safetensors')).toBe(true);
  });
});

describe('elapsed', () => {
  it('reads as wall-clock, which is the only honest progress signal here', () => {
    const start = Date.parse('2026-09-06T08:00:00.000Z');
    expect(elapsed('2026-09-06T08:00:00.000Z', start + 42_000)).toBe('42s');
    expect(elapsed('2026-09-06T08:00:00.000Z', start + 125_000)).toBe('2m 5s');
    expect(elapsed('2026-09-06T08:00:00.000Z', start + 3_900_000)).toBe('1h 5m');
  });
});

describe('the runnability filter', () => {
  const ready = makeRunnability({ status: 'ready' });
  const generic = makeRunnability({ status: 'generic' });
  const blocked = makeRunnability({ status: 'needs-companion' });
  const support = makeRunnability({ status: 'support' });

  it('counts the generic workflow as running, because it does', () => {
    // It is flagged differently on the card — nobody wrote that graph for this
    // model — but "will it run" and "is it any good" are different questions
    // and this filter only answers the first.
    expect(runs('generic')).toBe(true);
    expect(matchesRunFilter(generic, 'runs')).toBe(true);
    expect(matchesRunFilter(ready, 'runs')).toBe(true);
    expect(matchesRunFilter(blocked, 'runs')).toBe(false);
  });

  it('does not call a support file broken', () => {
    // A VAE is not a failed checkpoint. It appears under "everything" and
    // under neither of the narrowed views.
    expect(matchesRunFilter(support, 'blocked')).toBe(false);
    expect(matchesRunFilter(support, 'runs')).toBe(false);
    expect(matchesRunFilter(support, 'all')).toBe(true);
  });

  it('leaves an unjudged entry out of both narrowed lists', () => {
    // No verdict means the backend could not be asked. Counting it as working
    // would be the one wrong answer that costs somebody a 7 GB download.
    expect(matchesRunFilter(null, 'runs')).toBe(false);
    expect(matchesRunFilter(null, 'blocked')).toBe(false);
    expect(matchesRunFilter(null, 'all')).toBe(true);
  });

  it('narrows the catalogue with the other filters still applied', () => {
    const entries = [
      makeEntry({ ref: 'a', type: 'checkpoint', runnability: ready }),
      makeEntry({ ref: 'b', type: 'checkpoint', runnability: blocked }),
      makeEntry({ ref: 'c', type: 'lora', runnability: ready }),
    ];
    const filters = { type: 'checkpoint' as const, base: null, q: '' };
    expect(filterCatalogue(entries, { ...filters, run: 'all' })).toHaveLength(2);
    expect(filterCatalogue(entries, { ...filters, run: 'runs' })).toHaveLength(1);
    expect(filterCatalogue(entries, { ...filters, run: 'blocked' })).toHaveLength(1);
  });
});

describe('formatCount', () => {
  it('fits a download count in the width a card has for it', () => {
    expect(formatCount(412)).toBe('412');
    expect(formatCount(8_113)).toBe('8.1k');
    expect(formatCount(64_200)).toBe('64k');
    expect(formatCount(1_767_210)).toBe('1.8M');
    expect(formatCount(41_000_000)).toBe('41M');
  });
});
