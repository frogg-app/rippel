import { describe, expect, it } from 'vitest';
import type { Model } from '@comfy/shared';
import type { ModelReadiness } from '../lib/api-jobs';
import { fitPills, setupReason } from './modelReasons';
import { noticeHeadline } from './ModelNotice';
import type { ModelEntry } from './visibility';

const ltx: Model = {
  id: 'ltx', type: 'checkpoint', filename: 'model_weights_0306.safetensors', displayName: 'Model Weights 0306',
  baseModel: 'ltx-video', previewUrl: null, sizeBytes: null, source: 'local', sourceRef: null, backendIds: ['b'],
};

const blocked = (extra: Partial<ModelReadiness>): ModelReadiness => ({
  state: 'blocked', templateLabel: null, isFallback: false, videoLimits: null, summary: null, steps: [], ...extra,
});
const T5 = { label: 'T5 text encoder', type: 'clip' as const, misfiled: false };
const VAE = { label: 'LTX-Video VAE', type: 'vae' as const, misfiled: false };

function entry(runnable: boolean): ModelEntry {
  return { model: ltx, pending: false, runnable, hidden: null, blocked: runnable ? null : 'needs-setup', runsInMode: null };
}

describe('fitPills', () => {
  it('says "Will run" for a model that will', () => {
    expect(fitPills(entry(true), 'txt2vid', { here: {}, other: {}, loading: false })).toEqual([{ label: 'Will run', tone: 'ok' }]);
  });

  it('names each kind of missing part, once', () => {
    const readiness = { here: { ltx: blocked({ missing: [T5, VAE, { ...T5, label: 'CLIP-L' }] }) }, other: {}, loading: false };
    expect(fitPills(entry(false), 'txt2vid', readiness).map((pill) => pill.label)).toEqual([
      'Needs prompt reader',
      'Needs image decoder',
    ]);
  });

  it('says a file that cannot load cannot load, rather than asking for parts', () => {
    const readiness = {
      here: { ltx: blocked({ missing: [], problem: { kind: 'unloadable', summary: 's', detail: 'd' } }) },
      other: {},
      loading: false,
    };
    expect(fitPills(entry(false), 'txt2vid', readiness)).toEqual([{ label: 'Can’t load this file', tone: 'bad' }]);
  });
});

describe('setupReason', () => {
  it('counts the parts to install', () => {
    expect(setupReason(blocked({ missing: [T5, VAE] }))).toBe('Install the 2 missing parts first');
    expect(setupReason(blocked({ missing: [T5] }))).toBe('Install the missing part first');
  });

  it('is null for a model that is ready', () => {
    expect(setupReason({ ...blocked({}), state: 'ready' })).toBeNull();
  });
});

describe('noticeHeadline', () => {
  it('reads as the sentence a person would say', () => {
    expect(noticeHeadline(ltx, blocked({ missing: [T5, VAE] }))).toBe(
      'LTX-Video needs a prompt reader (T5 text encoder) and an image decoder (LTX-Video VAE) before it can run',
    );
    expect(noticeHeadline(ltx, blocked({ problem: { kind: 'unloadable', summary: 's', detail: 'd' } }))).toBe(
      'Model Weights 0306 can’t be loaded by ComfyUI',
    );
  });
});
