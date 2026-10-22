/**
 * What the sign-in and sign-up forms check before asking the server. Thin on
 * purpose: the API is the authority on what a valid password is, so the client
 * checks only what it can know without asking — that the fields are filled in
 * and the email is shaped like one.
 */
export interface AuthFields {
  email: string;
  password: string;
}

export type FieldErrors = Partial<Record<keyof AuthFields, string>>;

/** Something@something.something, no spaces: enough to catch typos, not to judge. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAuth({ email, password }: AuthFields): FieldErrors {
  const errors: FieldErrors = {};
  const trimmed = email.trim();
  if (trimmed === '') errors.email = 'Enter your email.';
  else if (!EMAIL.test(trimmed)) errors.email = 'That doesn’t look like an email address.';
  if (password === '') errors.password = 'Enter your password.';
  return errors;
}
