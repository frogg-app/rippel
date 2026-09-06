/**
 * Compilation failures come in two flavours and the distinction matters at the
 * route layer: a bad *value* is the user's problem and becomes a 400 naming the
 * field, while a bad *template* is our problem and must become a 500 plus a log
 * — a manifest pointing at a node that no longer exists is a deployment bug,
 * not something a user can fix by editing their prompt.
 */

export class ValidationError extends Error {
  constructor(
    /** The user-facing field name, e.g. "steps" or "prompt". */
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}
