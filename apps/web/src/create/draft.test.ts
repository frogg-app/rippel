import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '@comfy/shared';
import { clearDraft, droppedSentence, flushDraft, loadDraft, parseDraft, resetDraftStore, reviseDraft, saveDraft } from './draft';
import { initialFormState } from './form';

afterEach(() => {
  resetDraftStore();
  localStorage.clear();
  vi.useRealTimers();
});

const model = (id: string): Model => ({
  id, type: 'checkpoint', filename: `${id}.safetensors`, displayName: id, baseModel: null,
  previewUrl: null, sizeBytes: null, source: 'local', sourceRef: null, backendIds: ['b'],
});

describe('the draft store', () => {
  it('writes to storage per user, after the typing stops', () => {
    vi.useFakeTimers();
    const form = { ...initialFormState(), prompt: 'a lighthouse' };
    saveDraft('alice', form);
    expect(localStorage.getItem('rippel.create.draft.alice')).toBeNull();
    vi.advanceTimersByTime(500);
    expect(JSON.parse(localStorage.getItem('rippel.create.draft.alice')!).prompt).toBe('a lighthouse');
  });

  it('gives a user only their own draft', () => {
    saveDraft('alice', { ...initialFormState(), prompt: 'alice prompt' });
    flushDraft();
    resetDraftStore(); // a reload
    expect(loadDraft('alice')?.prompt).toBe('alice prompt');
    expect(loadDraft('bob')).toBeNull();
  });

  it('keeps a starting image as a reference, not its bytes', () => {
    const form = {
      ...initialFormState(),
      initImage: { source: { from: 'upload' as const, uploadId: 'u1' }, previewUrl: '/api/uploads/u1/thumb', influence: 0.6 },
    };
    saveDraft('alice', form);
    flushDraft();
    const stored = localStorage.getItem('rippel.create.draft.alice')!;
    expect(stored.length).toBeLessThan(2_000);
    expect(parseDraft(stored)?.initImage?.source).toEqual({ from: 'upload', uploadId: 'u1' });
  });

  it('forgets one user, or everyone on sign-out', () => {
    saveDraft('alice', initialFormState());
    flushDraft();
    saveDraft('bob', initialFormState());
    flushDraft();
    clearDraft('alice');
    expect(localStorage.getItem('rippel.create.draft.alice')).toBeNull();
    expect(localStorage.getItem('rippel.create.draft.bob')).not.toBeNull();
    clearDraft();
    expect(localStorage.getItem('rippel.create.draft.bob')).toBeNull();
    expect(loadDraft('bob')).toBeNull();
  });
});

describe('parseDraft', () => {
  it('fills what an older or damaged draft lacks from the defaults', () => {
    const parsed = parseDraft(JSON.stringify({ prompt: 'kept', batchSize: 'four', loras: [{ nope: 1 }] }))!;
    expect(parsed.prompt).toBe('kept');
    expect(parsed.batchSize).toBe(initialFormState().batchSize);
    expect(parsed.loras).toEqual([]);
    expect(parseDraft('not json')).toBeNull();
  });
});

describe('reviseDraft', () => {
  it('drops a model and add-ons that are no longer installed', () => {
    const form = {
      ...initialFormState(),
      modelId: 'gone',
      loras: [{ modelId: 'style-a', weight: 0.7 }, { modelId: 'style-gone', weight: 0.7 }],
    };
    const { form: next, dropped } = reviseDraft(form, { checkpoints: [model('here')], loras: [model('style-a')] });
    expect(next.modelId).toBeNull();
    expect(next.loras.map((l) => l.modelId)).toEqual(['style-a']);
    expect(droppedSentence(dropped)).toBe(
      'From your saved draft, the model and a style add-on are no longer installed, so they were removed.',
    );
  });

  it('leaves a draft alone when everything is still there', () => {
    const form = { ...initialFormState(), modelId: 'here' };
    expect(reviseDraft(form, { checkpoints: [model('here')], loras: [] }).dropped).toEqual([]);
  });
});
