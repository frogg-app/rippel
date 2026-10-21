/**
 * The weight slider's words.
 *
 * The bug this holds shut: every negative weight used to read "Off", while the
 * request sent it and the image changed. And the complaint behind the rewrite —
 * that every explanation "seems to say the same thing" — is checked literally:
 * no two bands may share a sentence.
 */
import { describe, expect, it } from 'vitest';
import { loraWeightReading, WEIGHT_SCALE } from './loraWeight';

describe('loraWeightReading', () => {
  it('only calls exactly zero Off, because only zero is left out of the job', () => {
    expect(loraWeightReading(0).word).toBe('Off');
    expect(loraWeightReading(-0.5).word).not.toBe('Off');
    expect(loraWeightReading(-0.5).hint).toMatch(/subtracted/);
  });

  it('gives each band its own word and its own sentence', () => {
    const readings = [-1, 0, 0.2, 0.7, 1, 1.8].map(loraWeightReading);
    expect(new Set(readings.map((r) => r.word)).size).toBe(readings.length);
    expect(new Set(readings.map((r) => r.hint)).size).toBe(readings.length);
  });

  it('anchors the scale on the trained strength, so 1.00 means something', () => {
    expect(WEIGHT_SCALE).toMatch(/1\.00 applies the style at the strength it was trained at/);
  });
});
