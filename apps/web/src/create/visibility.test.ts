/**
 * The hide/keep rule, at the level it is actually decided: one model, one
 * capability, one set of answers. The DOM tests in `routes/CreatePage.test.tsx`
 * cover what the picker then *says*; this covers what it decides.
 */
import { describe, expect, it } from 'vitest';
import type { Model } from '@comfy/shared';
import type { CapabilityMap, ModelReadiness } from '../lib/api-jobs';
import type { ReadinessMap } from './useReadiness';
import { classify, partitionModels } from './visibility';

function model(id: string, baseModel: string | null): Model {
  return {
    id,
    type: 'checkpoint',
    filename: `${id}.safetensors`,
    displayName: id,
    baseModel,
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: ['backend-1'],
  };
}

const live: CapabilityMap = {
  byFamily: { sdxl: ['txt2img'], ltxv: ['txt2vid'] },
  // What the real server says: an unclassified checkpoint gets the generic
  // image graphs, never nothing.
  unknownFamily: ['txt2img', 'img2img'],
  unknownIsFallback: true,
  live: true,
};
/** The map we hold when `GET /workflows` could not be reached: inert. */
const guessed: CapabilityMap = { byFamily: {}, unknownFamily: [], live: false };

function map(
  here: Record<string, ModelReadiness['state']> = {},
  other: Record<string, ModelReadiness['state']> = {},
): ReadinessMap {
  const build = (states: Record<string, ModelReadiness['state']>) =>
    Object.fromEntries(
      Object.entries(states).map(([id, state]) => [
        id,
        { state, templateLabel: null, isFallback: false, summary: null, steps: [] },
      ]),
    );
  return { here: build(here), other: build(other), loading: false };
}

/** The same, with the first probe still outstanding. */
function pendingMap(here: Record<string, ModelReadiness['state']> = {}): ReadinessMap {
  return { ...map(here), loading: true };
}

describe('while the probe is still in flight', () => {
  it('draws no verdict at all rather than the fallback map\'s guess', () => {
    // The guessed map knows only SDXL, so consulting it here would badge this
    // model "No template" and then take it back — the load flash.
    const entry = classify(model('a', 'hunyuan-video'), 'txt2img', guessed, pendingMap());
    expect(entry.pending).toBe(true);
    expect(entry.hidden).toBeNull();
    expect(entry.blocked).toBeNull();
    expect(entry.runnable).toBe(false);
  });

  it('hides nothing and counts nothing hidden', () => {
    const models = [model('a', 'sdxl'), model('b', 'hunyuan-video'), model('c', null)];
    const partition = partitionModels(models, 'txt2img', guessed, pendingMap());
    expect(partition.listed).toHaveLength(3);
    expect(partition.hidden).toHaveLength(0);
    expect(partition.hiddenNoTemplate).toHaveLength(0);
    expect(partition.pending).toBe(true);
  });

  it('still uses an answer that has already arrived for one model', () => {
    // A cached answer is a real answer, whatever the rest of the pass is doing.
    const entry = classify(model('a', 'sdxl'), 'txt2img', guessed, pendingMap({ a: 'ready' }));
    expect(entry.pending).toBe(false);
    expect(entry.runnable).toBe(true);
  });

  it('goes back to deciding once the answers land', () => {
    const partition = partitionModels(
      [model('a', 'sdxl'), model('b', 'hunyuan-video')],
      'txt2img',
      live,
      map({ a: 'ready', b: 'no-template' }),
    );
    expect(partition.pending).toBe(false);
    expect(partition.hiddenNoTemplate.map((entry) => entry.model.id)).toEqual(['b']);
  });
});

describe('classify', () => {
  it('hides a family with no workflow anywhere', () => {
    const entry = classify(model('a', 'hunyuan-video'), 'txt2img', live, map({ a: 'no-template' }));
    expect(entry.hidden).toBe('no-template');
  });

  it('hides a model that belongs to the other tab', () => {
    const entry = classify(
      model('a', 'ltxv'),
      'txt2img',
      live,
      map({ a: 'no-template' }, { a: 'ready' }),
    );
    expect(entry.hidden).toBe('other-mode');
    expect(entry.runsInMode).toBe('video');
  });

  it('keeps a model whose backend merely needs setting up', () => {
    const entry = classify(model('a', 'ltxv'), 'txt2vid', live, map({ a: 'blocked' }));
    expect(entry.hidden).toBeNull();
    expect(entry.blocked).toBe('needs-setup');
    expect(entry.runnable).toBe(false);
  });

  it('never hides because readiness could not be asked', () => {
    // Unknown, and an inert map to go on — which asserts nothing: show it.
    const entry = classify(model('a', 'mystery'), 'txt2img', guessed, map({ a: 'unknown' }));
    expect(entry.hidden).toBeNull();
    expect(entry.blocked).toBe('no-template');
  });

  it('falls back to the live capability map when readiness is silent', () => {
    expect(classify(model('a', 'sdxl'), 'txt2img', live, map()).runnable).toBe(true);
    expect(classify(model('a', 'ltxv'), 'txt2img', live, map()).hidden).toBe('other-mode');
    // A *named* family the live map does not carry is a real absence.
    expect(classify(model('a', 'mystery'), 'txt2img', live, map()).hidden).toBe('no-template');
  });

  it('runs a checkpoint whose family nobody could infer, rather than hiding it', () => {
    // The case the live endpoint changed. `baseModel: null` is not "no
    // workflow": the server holds a generic Stable Diffusion graph for exactly
    // this and reports it as `unknownFamily`, so an unclassified community
    // merge is selectable — on a best-guess graph, which the tile says.
    const entry = classify(model('a', null), 'txt2img', live, map());
    expect(entry.hidden).toBeNull();
    expect(entry.runnable).toBe(true);
  });

  it('still hides nothing on a null family when the map is not live', () => {
    const entry = classify(model('a', null), 'txt2img', guessed, map());
    expect(entry.hidden).toBeNull();
  });
});
