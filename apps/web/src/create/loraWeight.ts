/**
 * What the number on an extra style's slider means.
 *
 * The slider used to read "A hint / Usual / Strong / Overdone" and stop. Those
 * words say *more* or *less* but never *of what*, and they left three real
 * questions unanswered:
 *
 *   - What is 1.00? It is the strength the style was trained at — the whole
 *     learned change, applied once. Every other value is a fraction or a
 *     multiple of that, which is the one fact that makes the scale readable.
 *   - What happens below zero? The rail runs to -1, and `form.ts`'s
 *     `loraReading` called every negative value "Off", which was simply wrong:
 *     a negative weight is sent, and it pushes the picture *away* from what the
 *     style learned. A control that says Off while it is doing something is the
 *     worst kind of label.
 *   - Why does it break past 1.3 or so? Because the change is being applied
 *     more than once over, onto a model that was never trained to absorb it.
 *
 * Kept separate from `form.ts` so the wording is testable alongside the
 * description logic, and so each band's sentence can be checked for saying
 * something the band next to it does not.
 */
export interface WeightReading {
  /** A word or two for the value now. */
  word: string;
  /** What that value does to the picture, specific to this band. */
  hint: string;
}

/** The scale, once, for the section's own explanation. */
export const WEIGHT_SCALE =
  '1.00 applies the style at the strength it was trained at. 0.50 is half of that change, ' +
  '2.00 is double. At exactly 0 the style is left out of the job entirely.';

export function loraWeightReading(weight: number): WeightReading {
  if (weight < 0) {
    return {
      word: 'Reversed',
      hint:
        'Below zero the style is subtracted: the picture is pushed away from what it learned. ' +
        'Occasionally useful to remove a look a model has by default; usually it just damages the image.',
    };
  }
  if (weight === 0) {
    return {
      word: 'Off',
      hint: 'Exactly zero, so this style is dropped from the job and the model runs without it.',
    };
  }
  if (weight < 0.4) {
    return {
      word: 'A trace',
      hint: 'Under half strength. It nudges colour and texture but rarely changes the subject or composition.',
    };
  }
  if (weight <= 0.9) {
    return {
      word: 'Usual',
      hint:
        'Just under the trained strength, where most people run a style: clearly present, ' +
        'while still leaving room for the prompt and any other styles.',
    };
  }
  if (weight <= 1.3) {
    return {
      word: 'Full',
      hint:
        'At or a little past the trained strength. The style now wins arguments with the prompt, ' +
        'and a second style stacked beside it will be crowded out.',
    };
  }
  return {
    word: 'Overdone',
    hint:
      'Well past what it was trained for. Expect burnt colour, repeated patterns and broken hands ' +
      'or faces — the change is being applied more times over than the model can absorb.',
  };
}
