import { describe, expect, it } from 'vitest';
import { validateAuth } from './auth-validation';

describe('validateAuth', () => {
  it('asks for both fields when empty', () => {
    expect(validateAuth({ email: '', password: '' })).toEqual({
      email: 'Enter your email.',
      password: 'Enter your password.',
    });
  });

  it('treats a blank email as empty', () => {
    expect(validateAuth({ email: '   ', password: 'x' }).email).toBe('Enter your email.');
  });

  it.each(['plain', 'a@b', '@b.c', 'a b@c.d', 'a@b.'])('rejects %s as an email', (email) => {
    expect(validateAuth({ email, password: 'x' }).email).toMatch(/look like an email/);
  });

  it.each(['a@b.c', 'first.last+tag@example.co.uk', ' padded@example.com '])('accepts %s', (email) => {
    expect(validateAuth({ email, password: 'x' })).toEqual({});
  });
});
