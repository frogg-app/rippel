/**
 * Which extra styles are offered, decided one style at a time.
 *
 * The rule under test is the one that matters editorially: an unknown family
 * is not a mismatch. Almost every locally discovered LoRA has no `baseModel`,
 * so a picker that treated "unknown" as "does not fit" would be empty on a
 * normal install — which is exactly the failure mode the checkpoint grid had.
 */
import { describe, expect, it } from 'vitest';
import type { Model } from '@comfy/shared';
import { fitOf, invalidLoras, matchesQuery, partitionLoras } from './loras';

function model(id: string, baseModel: string | null, name = id): Model {
  return {
    id,
    type: 'lora',
    filename: `${id}.safetensors`,
    displayName: name,
    baseModel,
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: ['backend-1'],
  };
}

// `/api/models` folds both sides of this comparison with the same function, so
// a checkpoint and a LoRA of one family arrive spelled identically.
const sdxl = model('ckpt', 'sdxl', 'SDXL Base');

describe('fitOf', () => {
  it('matches on the folded family, so punctuation and case do not matter', () => {
    expect(fitOf(model('a', 'sdxl'), sdxl)).toBe('fits');
    expect(fitOf(model('b', 'Hunyuan Video'), model('c', 'hunyuan-video'))).toBe('fits');
  });

  it('calls a known difference a mismatch', () => {
    expect(fitOf(model('a', 'sd15'), sdxl)).toBe('mismatch');
  });

  it('never guesses when either side has no family', () => {
    expect(fitOf(model('a', null), sdxl)).toBe('unknown');
    expect(fitOf(model('a', 'sd15'), model('c', null))).toBe('unknown');
    // No checkpoint chosen yet is not grounds for hiding anything.
    expect(fitOf(model('a', 'sd15'), null)).toBe('unknown');
  });
});

describe('partitionLoras', () => {
  const installed = [
    model('z-fit', 'sdxl', 'Zebra Film'),
    model('a-fit', 'sdxl', 'Alpine Ink'),
    model('unknown', null, 'Pytorch LoRA Weights'),
    model('wrong', 'sd15', 'Hyper SD15 1step LoRA'),
  ];

  it('offers what fits first, then the unknowns, alphabetically inside each', () => {
    const { offered, fitting } = partitionLoras(installed, sdxl);
    expect(offered.map((entry) => entry.model.id)).toEqual(['a-fit', 'z-fit', 'unknown']);
    expect(fitting).toBe(2);
  });

  it('hides the known mismatch, and keeps it countable rather than deleting it', () => {
    const { offered, hidden } = partitionLoras(installed, sdxl);
    expect(offered.some((entry) => entry.model.id === 'wrong')).toBe(false);
    expect(hidden.map((entry) => entry.model.id)).toEqual(['wrong']);
  });

  it('drops the ones already chosen — the picker adds, the stack holds', () => {
    const { offered } = partitionLoras(installed, sdxl, [{ modelId: 'a-fit', weight: 0.7 }]);
    expect(offered.map((entry) => entry.model.id)).toEqual(['z-fit', 'unknown']);
  });

  it('hides nothing at all when no checkpoint is chosen', () => {
    const { offered, hidden } = partitionLoras(installed, null);
    expect(hidden).toHaveLength(0);
    expect(offered).toHaveLength(4);
  });
});

describe('matchesQuery', () => {
  const entry = { model: model('a', 'sdxl', 'Alpine Ink'), fit: 'fits' as const, family: 'sdxl' };

  it('matches the name or the family, case-insensitively', () => {
    expect(matchesQuery(entry, 'alp')).toBe(true);
    expect(matchesQuery(entry, 'SDXL')).toBe(true);
    expect(matchesQuery(entry, 'sdxl')).toBe(true);
    expect(matchesQuery(entry, 'zebra')).toBe(false);
  });

  it('treats an empty or blank query as no filter', () => {
    expect(matchesQuery(entry, '')).toBe(true);
    expect(matchesQuery(entry, '   ')).toBe(true);
  });
});

describe('invalidLoras', () => {
  const pytorch = model('pt', null, 'Pytorch LoRA Weights');
  const sd15 = model('sd15', 'sd1.5', 'Hyper SD15');
  const sdxlStyle = model('xl', 'sdxl', 'XL style');

  it('drops every style for a workflow that takes none, and says why', () => {
    const result = invalidLoras([{ modelId: 'pt', weight: 0.7 }], [pytorch], model('ltx', 'ltx-video'), false, 'LTX-Video');
    expect(result.keep).toEqual([]);
    expect(result.notice).toBe('Removed Pytorch LoRA Weights: LTX-Video workflows don’t take style add-ons.');
  });

  it('drops a style made for another family, and keeps fitting and unknown ones', () => {
    const chosen = [
      { modelId: 'sd15', weight: 0.7 },
      { modelId: 'xl', weight: 0.7 },
      { modelId: 'pt', weight: 0.7 },
    ];
    const result = invalidLoras(chosen, [pytorch, sd15, sdxlStyle], sdxl, true, 'SDXL');
    expect(result.keep.map((s) => s.modelId)).toEqual(['xl', 'pt']);
    expect(result.notice).toMatch(/Removed Hyper SD15/);
  });

  it('says nothing when everything still fits', () => {
    expect(invalidLoras([{ modelId: 'xl', weight: 1 }], [sdxlStyle], sdxl, true, 'SDXL').notice).toBeNull();
  });
});
