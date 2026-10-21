import { describe, expect, it } from 'vitest';
import { familyHint, familyWords } from './families';

describe('familyWords', () => {
  it('names a family the way people say it, whatever spelling arrives', () => {
    expect(familyWords('sdxl').label).toBe('Stable Diffusion XL');
    expect(familyWords('flux.1').label).toBe('FLUX.1');
    expect(familyWords('ltx-video').label).toBe('LTX-Video');
    expect(familyWords('LTXV').label).toBe('LTX-Video');
    expect(familyWords('wan2.2').label).toBe('Wan 2.2');
  });

  it('says what a known family is good for, and how quick it is', () => {
    const words = familyWords('ltx-video');
    expect(words.goodFor).toMatch(/video/i);
    expect(words.speed).toBe('fast');
    expect(familyHint('ltx-video')).toBe('Short video clips, quickly · Quick');
  });

  it('degrades to the display name, with no hint, for a family it does not know', () => {
    expect(familyWords('mystery-merge')).toEqual({ label: 'Mystery Merge', goodFor: null, speed: null });
    expect(familyHint('mystery-merge')).toBeNull();
  });

  it('still calls an unclassified model something', () => {
    expect(familyWords(null).label).toBe('Unknown kind of model');
    expect(familyHint(undefined)).toBeNull();
  });
});
