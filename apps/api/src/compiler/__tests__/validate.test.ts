import { describe, expect, it } from 'vitest';

import { ValidationError } from '../errors.js';
import { MAX_PROMPT_LENGTH, checkValue } from '../validate.js';

describe('checkValue', () => {
  it('accepts values inside the constraint', () => {
    expect(checkValue('prompt', 'hello', { kind: 'string', maxLength: 100 })).toBe('hello');
    expect(checkValue('steps', 20, { kind: 'int', min: 1, max: 150 })).toBe(20);
    expect(checkValue('guidance', 7.5, { kind: 'float', min: 1, max: 20 })).toBe(7.5);
    expect(checkValue('sampler', 'euler', { kind: 'enum', values: ['euler', 'ddim'] })).toBe('euler');
    expect(
      checkValue('model', 'sd_xl_base_1.0.safetensors', { kind: 'model', modelType: 'checkpoint' }),
    ).toBe('sd_xl_base_1.0.safetensors');
  });

  it('rejects wrong types with the field name in the message', () => {
    expect(() => checkValue('prompt', 42, { kind: 'string', maxLength: 10 })).toThrow(
      /prompt must be text/,
    );
    expect(() => checkValue('steps', '20', { kind: 'int', min: 1, max: 2 })).toThrow(
      /steps must be a number/,
    );
    expect(() => checkValue('steps', NaN, { kind: 'int', min: 1, max: 2 })).toThrow(ValidationError);
  });

  it('caps string length even when the manifest is generous', () => {
    const long = 'x'.repeat(MAX_PROMPT_LENGTH + 1);
    expect(() => checkValue('prompt', long, { kind: 'string', maxLength: 1_000_000 })).toThrow(
      /at most 8000 characters/,
    );
    // A stricter manifest cap wins.
    expect(() => checkValue('prompt', 'abcd', { kind: 'string', maxLength: 3 })).toThrow(
      /at most 3 characters/,
    );
  });

  it('enforces whole numbers and the step for an int', () => {
    expect(() => checkValue('width', 1000.5, { kind: 'int', min: 8, max: 2048 })).toThrow(
      /whole number/,
    );
    expect(() => checkValue('width', 1020, { kind: 'int', min: 8, max: 2048, step: 8 })).toThrow(
      /multiple of 8/,
    );
    // A float has no such constraint.
    expect(checkValue('guidance', 7.25, { kind: 'float', min: 0, max: 30 })).toBe(7.25);
  });

  it('enforces range on both int and float', () => {
    expect(() => checkValue('steps', 500, { kind: 'int', min: 1, max: 150 })).toThrow(
      /between 1 and 150/,
    );
    expect(() => checkValue('guidance', 99, { kind: 'float', min: 1, max: 20 })).toThrow(
      /between 1 and 20/,
    );
  });

  it('names the legal set for an enum miss', () => {
    expect(() => checkValue('sampler', 'nope', { kind: 'enum', values: ['euler', 'ddim'] })).toThrow(
      /sampler must be one of: euler, ddim/,
    );
  });
});
