/**
 * Constraint checking for every value that reaches the graph.
 *
 * This runs before substitution, not during, so a rejected request never leaves
 * a half-populated graph behind and the error names the field the user sees
 * ("steps"), not the address we happened to write it to ("3.inputs.steps").
 */

import { ValidationError } from './errors.js';
import type { ManifestBinding, ManifestConstraint } from './manifest.js';

/** Belt-and-braces cap applied to every string regardless of the manifest. */
export const MAX_PROMPT_LENGTH = 8000;

/**
 * `field` is the machine name, carried on the thrown error so the API can point
 * a client at the offending field; `label` is what the user actually sees in
 * the UI and is what the message reads. They differ deliberately — "batchSize"
 * is meaningless in an error toast that should say "Images".
 */
export function checkValue(
  field: ManifestBinding | string,
  value: unknown,
  constraint: ManifestConstraint,
  label: string = field,
): string | number | boolean {
  switch (constraint.kind) {
    case 'string':
      return checkString(field, value, constraint, label);
    case 'int':
      return checkNumber(
        field,
        value,
        { min: constraint.min, max: constraint.max, integer: true, multipleOf: constraint.step },
        label,
      );
    case 'float':
      return checkNumber(field, value, { min: constraint.min, max: constraint.max }, label);
    case 'enum':
      return checkEnum(field, value, constraint, label);
    case 'model':
      // The value is a filename the caller already resolved from a modelId, and
      // whether that file exists on the chosen backend was settled before we
      // were called. All that is left to check is that it is a usable string.
      return checkString(field, value, { kind: 'string', maxLength: 512 }, label);
  }
}

/** The numeric bounds `int` and `float` share, once normalised. */
interface NumberBounds {
  min: number;
  max: number;
  integer?: boolean;
  multipleOf?: number;
}

function checkString(
  field: string,
  value: unknown,
  constraint: Extract<ManifestConstraint, { kind: 'string' }>,
  label: string,
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(field, `${label} must be text`);
  }
  // The manifest's own cap wins when it is stricter; the global cap exists so a
  // manifest that forgot to set one cannot let a megabyte of text reach ComfyUI,
  // where the failure mode is a stalled worker rather than an error.
  const max = Math.min(constraint.maxLength, MAX_PROMPT_LENGTH);
  if (value.length > max) {
    throw new ValidationError(field, `${label} must be at most ${max} characters (got ${value.length})`);
  }
  return value;
}

function checkNumber(
  field: string,
  value: unknown,
  constraint: NumberBounds,
  label: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(field, `${label} must be a number`);
  }
  if (constraint.integer && !Number.isInteger(value)) {
    throw new ValidationError(field, `${label} must be a whole number (got ${value})`);
  }
  if (value < constraint.min || value > constraint.max) {
    throw new ValidationError(
      field,
      `${label} must be between ${constraint.min} and ${constraint.max} (got ${value})`,
    );
  }
  if (constraint.multipleOf !== undefined && value % constraint.multipleOf !== 0) {
    throw new ValidationError(
      field,
      `${label} must be a multiple of ${constraint.multipleOf} (got ${value})`,
    );
  }
  return value;
}

function checkEnum(
  field: string,
  value: unknown,
  constraint: Extract<ManifestConstraint, { kind: 'enum' }>,
  label: string,
): string {
  if (typeof value !== 'string' || !constraint.values.includes(value)) {
    throw new ValidationError(
      field,
      `${label} must be one of: ${constraint.values.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}
