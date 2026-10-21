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
        { state, templateLabel: null, isFallback: false, videoLimits: null, summary: null, steps: [] },
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

  it('hides a wrong-mode model at once, without waiting on a probe', () => {
    // The reported flash. The live map alone settles this: `ltxv` offers
    // txt2vid, so under Image there is nothing a per-model readiness probe
    // could add — it is the wrong tab, not a machine that needs setting up.
    const entry = classify(model('a', 'ltxv'), 'txt2img', live, pendingMap());
    expect(entry.pending).toBe(false);
    expect(entry.hidden).toBe('other-mode');
    expect(entry.runsInMode).toBe('video');
  });

  it('hides a family the live map does not carry at once', () => {
    const entry = classify(model('a', 'mystery'), 'txt2img', live, pendingMap());
    expect(entry.pending).toBe(false);
    expect(entry.hidden).toBe('no-template');
  });

  it('still waits on the probe when only the machine setup is in question', () => {
    // `ltxv` *does* offer txt2vid, so whether this box can actually run it is
    // the one thing the map cannot answer. That is a badge on a tile already on
    // screen, so it may land late without moving anything.
    const entry = classify(model('a', 'ltxv'), 'txt2vid', live, pendingMap());
    expect(entry.pending).toBe(true);
    expect(entry.hidden).toBeNull();
    expect(entry.blocked).toBeNull();
  });

  it('hides nothing early on a map that is not live', () => {
    // The failure path, unchanged: an unreachable `GET /workflows` proves
    // nothing, and must never be the reason the grid empties.
    for (const family of ['ltxv', 'mystery', 'hunyuan-video']) {
      const entry = classify(model('a', family), 'txt2img', guessed, pendingMap());
      expect(entry.pending).toBe(true);
      expect(entry.hidden).toBeNull();
    }
  });

  it('keeps an unclassified checkpoint on the first paint', () => {
    // `baseModel: null` runs on the generic graph. It must not be swept up by
    // the early hide — it is listed, and pending only on its setup probe.
    const entry = classify(model('a', null), 'txt2img', live, pendingMap());
    expect(entry.hidden).toBeNull();
    expect(entry.pending).toBe(true);
  });

  it('settles the first paint without a single probe answering', () => {
    // Three of six on the real box: the count the grid opens at, and stays at.
    const models = [
      model('sdxl', 'sdxl'),
      model('hunyuan-video', 'hunyuan-video'),
      model('ltx', 'ltx-video'),
    ];
    const capabilities: CapabilityMap = {
      byFamily: {
        sdxl: ['txt2img', 'img2img'],
        hunyuanvideo: ['txt2vid'],
        ltxvideo: ['txt2vid', 'img2vid'],
      },
      unknownFamily: ['txt2img', 'img2img'],
      live: true,
    };
    const first = partitionModels(models, 'txt2img', capabilities, pendingMap());
    expect(first.listed.map((entry) => entry.model.id)).toEqual(['sdxl']);

    // ...and the same list once every probe has answered: nothing moves.
    const settled = partitionModels(
      models,
      'txt2img',
      capabilities,
      map({ sdxl: 'ready', 'hunyuan-video': 'no-template', ltx: 'no-template' }, { 'hunyuan-video': 'ready', ltx: 'ready' }),
    );
    expect(settled.listed.map((entry) => entry.model.id)).toEqual(['sdxl']);
  });

  it('can hide a listed pending entry once its probe lands, so pending must not be drawn', () => {
    // The reload jump, stated as the rule it broke. The live map says Hunyuan
    // does txt2vid, so under Video nothing settles it early and it is listed
    // as pending. The probe then says no graph is installed and the other tab
    // would run it: hidden. Any picker that drew `listed` while `pending` was
    // true painted this tile and took it away — which is why the picker now
    // draws a skeleton until the partition is settled.
    const models = [model('hunyuan', 'hunyuan-video')];
    const capabilities: CapabilityMap = {
      byFamily: { hunyuanvideo: ['txt2vid'] },
      unknownFamily: [],
      live: true,
    };
    const early = partitionModels(models, 'txt2vid', capabilities, pendingMap());
    expect(early.pending).toBe(true);
    expect(early.listed.map((entry) => entry.model.id)).toEqual(['hunyuan']);

    const settled = partitionModels(
      models,
      'txt2vid',
      capabilities,
      map({ hunyuan: 'no-template' }),
    );
    expect(settled.pending).toBe(false);
    expect(settled.listed).toHaveLength(0);
  });

  it('holds every entry undecided on a map that is not live, however many there are', () => {
    // The other half of the jump: `GET /workflows` failed, so nothing can be
    // settled early and the whole list is pending until the probes answer.
    const models = [model('a', 'sdxl'), model('b', 'ltxv'), model('c', 'mystery')];
    const partition = partitionModels(models, 'txt2img', guessed, pendingMap());
    expect(partition.pending).toBe(true);
    expect(partition.listed.every((entry) => entry.pending)).toBe(true);
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

  it('asks an img2-only family for a starting image rather than hiding it', () => {
    // SVD on the real box: `img2vid` and nothing else. The txt2vid probe says
    // "no template" truthfully, but this is a video model under Video — not one
    // from the other tab — and the fix is a starting image, not a mode switch.
    // Hiding it on the probe's word was a second show-then-hide, at +4.3s.
    const capabilities: CapabilityMap = {
      byFamily: { svd: ['img2vid'] },
      unknownFamily: [],
      live: true,
    };
    const readiness = map({ a: 'no-template' }, { a: 'ready' });

    const entry = classify(model('a', 'svd'), 'txt2vid', capabilities, readiness);
    expect(entry.hidden).toBeNull();
    expect(entry.blocked).toBe('needs-image');

    // ...and it is the same verdict the map gives before any probe answers, so
    // the tile does not move when the probe lands.
    const early = classify(model('a', 'svd'), 'txt2vid', capabilities, pendingMap());
    expect(early.hidden).toBeNull();
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
