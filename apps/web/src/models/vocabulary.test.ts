import { describe, expect, it } from 'vitest';
import { EXPERT_LABELS, MODEL_TYPES, SUPPORT_ROLES, TYPE_LABELS } from './catalogue';
import { GROUPS, GROUP_ORDER, VOCABULARY, expertFor, nameWithExpert } from './vocabulary';

describe('the vocabulary', () => {
  it('words every type, with the expert term kept apart from the friendly one', () => {
    for (const type of MODEL_TYPES) {
      const words = VOCABULARY[type];
      expect(words.name).toBeTruthy();
      expect(words.explain).toMatch(/\.$/);
      expect(words.expert).toBeTruthy();
      expect(words.name).not.toBe(words.expert);
    }
    expect(VOCABULARY.checkpoint.name).toBe('Model');
    expect(VOCABULARY.lora.name).toBe('Style add-on');
  });

  it('puts every type in exactly one legend group', () => {
    const listed = GROUP_ORDER.flatMap((group) => GROUPS[group].types);
    expect([...listed].sort()).toEqual([...MODEL_TYPES].sort());
    for (const group of GROUP_ORDER) {
      for (const type of GROUPS[group].types) expect(VOCABULARY[type].group).toBe(group);
    }
  });

  it('is the one source the older catalogue names read from', () => {
    expect(TYPE_LABELS.lora).toBe('Style add-ons');
    expect(EXPERT_LABELS.lora).toBe('LoRA');
    expect(SUPPORT_ROLES.vae.noun).toBe(VOCABULARY.vae.name);
    expect(SUPPORT_ROLES.vae.what).toBe(VOCABULARY.vae.explain);
  });

  it('names a text encoder by its file when the file says which', () => {
    expect(expertFor('clip', 't5xxl_fp16.safetensors')).toBe('Text encoder (T5)');
    expect(expertFor('clip', 'clip_l.safetensors')).toBe('Text encoder (CLIP)');
    expect(expertFor('clip', 'mystery.safetensors')).toBe('Text encoder (CLIP / T5)');
    expect(expertFor('lora', 't5.safetensors')).toBe('LoRA');
  });

  it('says "Prompt reader · text encoder", not "Technically a CLIP"', () => {
    expect(nameWithExpert('clip')).toBe('Prompt reader · text encoder');
  });
});
