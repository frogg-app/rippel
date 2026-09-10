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
  familyLabel,
  filterCatalogue,
  filterInstalled,
  foldFamily,
  formatBytes,
  formatCount,
  groupInstalled,
  latestByFilename,
  matchesRunFilter,
  percentComplete,
  remaining,
  runs,
  transferRate,
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

describe('familyLabel', () => {
  it('spells the families we know the way they are written', () => {
    // The reported spellings — "Sd1.5", "Ltx Video", "Sdxl" — came from a
    // plain title-case, which is the wrong tool for acronyms and versions.
    expect(familyLabel('sd1.5')).toBe('SD 1.5');
    expect(familyLabel('ltx-video')).toBe('LTX-Video');
    expect(familyLabel('sdxl')).toBe('SDXL');
    expect(familyLabel('svd')).toBe('SVD');
    expect(familyLabel('hunyuan-video')).toBe('Hunyuan Video');
    expect(familyLabel('hunyuan-dit')).toBe('Hunyuan DiT');
  });

  it('reaches one answer whatever spelling it is handed', () => {
    // `/api/models` folds, the catalogue does not, and `WorkflowSheet` passes
    // already-folded keys. All three must land on the same label.
    for (const spelling of ['ltx-video', 'LTXV', 'ltxvideo', 'LTX Video']) {
      expect(familyLabel(spelling)).toBe('LTX-Video');
    }
    expect(familyLabel(foldFamily('SD 1.5'))).toBe('SD 1.5');
  });

  it('still improves on title-case for a family it has never heard of', () => {
    expect(familyLabel('some-new-vae')).toBe('Some New VAE');
    expect(familyLabel('acme3.2')).toBe('Acme3.2');
    expect(familyLabel('unclassified')).toBe('Unclassified');
  });

  it('does not invent a separator that the name already has', () => {
    expect(familyLabel('flux.1')).toBe('FLUX.1');
  });
});

describe('groupInstalled', () => {
  it('orders by type, then family, with the unclassified last', () => {
    const groups = groupInstalled([
      makeModel({ id: 'a', type: 'lora', baseModel: 'sdxl' }),
      makeModel({ id: 'b', type: 'checkpoint', baseModel: null }),
      makeModel({ id: 'c', type: 'checkpoint', baseModel: 'flux.1' }),
    ]);
    // Families are spelled the way they are written, not title-cased: see
    // `familyLabel`. Ordering is still alphabetical on those labels.
    expect(groups.map((group) => `${group.type}/${group.family}`)).toEqual([
      'checkpoint/FLUX.1',
      'checkpoint/Unclassified',
      'lora/SDXL',
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


/**
 * The numbers on the download display.
 *
 * These are small functions guarding one rule that is easy to break by
 * accident: a percentage may exist only when both a measured byte count and an
 * exact total exist. Everything else on the screen degrades to prose, and none
 * of it may quietly become a zero.
 */
describe('formatBytes', () => {
  it('uses decimal units, to match every other size on the screen', () => {
    // Manager quotes "6.94GB" for this file and HuggingFace's Content-Length
    // agrees; saying "6.46 GiB" next to that would just look like a bug.
    expect(formatBytes(6_938_078_334)).toBe('6.94 GB');
    expect(formatBytes(327_309_314)).toBe('327 MB');
    expect(formatBytes(81_918_064)).toBe('81.9 MB');
  });

  it('holds three significant figures across the scales', () => {
    expect(formatBytes(1_240_000_000)).toBe('1.24 GB');
    expect(formatBytes(25_000)).toBe('25.0 kB');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('says zero rather than rounding it away', () => {
    expect(formatBytes(0)).toBe('0 B');
  });
});

describe('percentComplete', () => {
  it('is a real fraction when both halves are real', () => {
    expect(percentComplete(3_469_039_167, 6_938_078_334)).toBeCloseTo(50, 5);
  });

  it('is null without an exact total, rather than a zero', () => {
    // This is the whole guard. A download with no known total renders no bar;
    // returning 0 here would draw one that claims nothing has arrived.
    expect(percentComplete(3_000_000_000, null)).toBeNull();
  });

  it('is null when nothing has been measured', () => {
    expect(percentComplete(null, 6_938_078_334)).toBeNull();
  });

  it('is zero - a real zero - for a download that has written nothing yet', () => {
    expect(percentComplete(0, 6_938_078_334)).toBe(0);
  });

  it('never exceeds 100, so a resumed or padded file cannot overflow the bar', () => {
    expect(percentComplete(7_000_000_000, 6_938_078_334)).toBe(100);
  });
});

describe('transferRate', () => {
  const started = '2026-09-06T08:00:00.000Z';
  const at = (seconds: number) => Date.parse(started) + seconds * 1000;

  it('averages the bytes over the whole download so far', () => {
    expect(transferRate(120_000_000, started, at(10))).toBe(12_000_000);
  });

  it('waits until there is enough elapsed time to divide by', () => {
    // A rate computed over the first second is poll jitter, not information.
    expect(transferRate(120_000_000, started, at(1))).toBeNull();
  });

  it('is null with nothing measured, or nothing started', () => {
    expect(transferRate(null, started, at(30))).toBeNull();
    expect(transferRate(120_000_000, null, at(30))).toBeNull();
  });
});

describe('remaining', () => {
  it('divides what is left by the rate actually achieved', () => {
    // 3.0 GB still to come at 10 MB/s is 300 seconds.
    expect(remaining(3_000_000_000, 6_000_000_000, 10_000_000)).toBe('5m');
  });

  it('is null without a total, because there is nothing to subtract from', () => {
    expect(remaining(3_000_000_000, null, 10_000_000)).toBeNull();
  });

  it('is null once nothing is left, rather than counting down past zero', () => {
    expect(remaining(6_000_000_000, 6_000_000_000, 10_000_000)).toBeNull();
  });
});
