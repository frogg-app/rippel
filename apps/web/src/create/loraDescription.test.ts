/**
 * What a style's filename is allowed to say about it.
 *
 * Two failures are held shut here, and the second matters more than the first.
 *
 * The first is silence where the name is informative: a `2step` LoRA left at
 * the preset's 28 steps looks worse and takes longer, and the only place that
 * fact lives on this install is the filename.
 *
 * The second is invention. The obvious "improvement" to this module is to map
 * `film`, `anime` or `krea` to a sentence about the look, and every one of those
 * sentences would be a guess presented as fact. The refusal tests below exist
 * so that improvement fails loudly.
 */
import { describe, expect, it } from 'vitest';
import { describeLora } from './loraDescription';

const subject = (filename: string, baseModel: string | null = null, displayName = filename) => ({
  filename,
  displayName,
  baseModel,
});

describe('describeLora: what the name supports', () => {
  it('reads a step count and ties it to the Detail control by name', () => {
    const d = describeLora(subject('sdxl_lightning_2step_lora.safetensors', 'sdxl'));
    expect(d.stepTarget).toBe(2);
    expect(d.needsLowSteps).toBe(true);
    expect(d.derived[0]).toMatch(/2 steps/);
    // The vocabulary fix: "step" in a filename is the same step as Advanced's.
    expect(d.derived[0]).toMatch(/Advanced → Detail to about 2/);
    expect(d.unknown).toBe(false);
  });

  it('survives underscores, which a naive \\b regex does not', () => {
    // The bug: `_` is a word character, so `\bi2v\b` never matched inside the
    // one naming style every one of these files uses.
    const d = describeLora(
      subject('lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', 'wan'),
    );
    const all = d.derived.join('\n');
    expect(all).toMatch(/I2V/);
    expect(all).toMatch(/480p/);
    expect(all).toMatch(/CFG-distilled/);
    expect(all).toMatch(/Rank 64 describes the size of the file, not how strong/);
    expect(all).toMatch(/bf16/);
    expect(d.needsLowSteps).toBe(true);
    // No number in the name, so none is invented.
    expect(d.stepTarget).toBeNull();
  });

  it('does not read a family word into "sd15 1step" as fifteen steps', () => {
    expect(describeLora(subject('Hyper-SD15-1step-lora.safetensors', 'sd15')).stepTarget).toBe(1);
  });

  it('offers a hedged family only when nothing recorded one', () => {
    const unrecorded = describeLora(subject('sdxl_lightning_8step_lora.safetensors', null));
    expect(unrecorded.derived.join('\n')).toMatch(/likely family/);
    const recorded = describeLora(subject('sdxl_lightning_8step_lora.safetensors', 'sdxl'));
    expect(recorded.derived.join('\n')).not.toMatch(/likely family/);
  });

  it('says a "style" file does not say which style, rather than guessing one', () => {
    const d = describeLora(subject('krea2_style_reference.safetensors', null));
    expect(d.derived).toHaveLength(1);
    expect(d.derived[0]).toMatch(/does not say which one/);
  });
});

describe('describeLora: what it refuses to claim', () => {
  it('knows nothing about a name that is only words about a look', () => {
    // Very probably film grain. "Very probably" is not a sentence we print.
    const d = describeLora(subject('film_grain_xl.safetensors', 'sdxl', 'Film Grain XL'));
    expect(d.unknown).toBe(true);
    expect(d.derived).toEqual([]);
  });

  it('knows nothing about the generic name diffusers gives every file', () => {
    const d = describeLora(subject('pytorch_lora_weights.safetensors', null));
    expect(d.unknown).toBe(true);
  });

  it('never mentions an artistic quality, whatever the name contains', () => {
    const names = [
      'anime_portrait_style.safetensors',
      'watercolor_painterly_v2.safetensors',
      'cinematic_film_look.safetensors',
    ];
    for (const name of names) {
      const text = describeLora(subject(name)).derived.join(' ').toLowerCase();
      for (const word of ['anime', 'portrait', 'watercolor', 'painterly', 'cinematic', 'film']) {
        expect(text).not.toContain(word);
      }
    }
  });

  it('does not read "xl" as SDXL — too many other things are extra large', () => {
    const d = describeLora(subject('film_grain_xl.safetensors', null));
    expect(d.derived.join(' ')).not.toMatch(/SDXL/);
  });

  it('does not take a version number or a size for a step count', () => {
    expect(describeLora(subject('style_v2_14B.safetensors')).stepTarget).toBeNull();
    expect(describeLora(subject('stepper_motor.safetensors')).stepTarget).toBeNull();
  });
});

describe('describeLora: real metadata wins', () => {
  it('passes a given description and trigger words through untouched', () => {
    const d = describeLora(subject('pytorch_lora_weights.safetensors'), {
      description: '  Hand-inked comic linework.  ',
      triggerWords: ['inkstyle', ' '],
    });
    expect(d.given).toBe('Hand-inked comic linework.');
    expect(d.triggerWords).toEqual(['inkstyle']);
    expect(d.unknown).toBe(false);
  });

  it('treats a blank description as no description, not as a known one', () => {
    expect(describeLora(subject('pytorch_lora_weights.safetensors'), { description: '   ' }).unknown).toBe(true);
  });
});
