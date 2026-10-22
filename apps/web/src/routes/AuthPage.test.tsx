import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthState } from '../auth/context';
import { ApiRequestError } from '../lib/api';
import { AuthPage } from './AuthPage';

function setup(mode: 'login' | 'register' = 'login', signIn: AuthState['signIn'] = vi.fn(async () => {})) {
  const signUp = vi.fn(async () => {});
  const auth: AuthState = { status: 'anonymous', user: null, allowRegistration: true, signIn, signUp, signOut: async () => {} };
  const view = render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter>
        <AuthPage mode={mode} />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return { ...view, signIn, signUp };
}

const submit = () => userEvent.click(screen.getByRole('button', { name: /sign in|create account/i }));

describe('AuthPage validation', () => {
  it('validates itself instead of leaving it to the browser', () => {
    const { container } = setup();
    expect(container.querySelector('form')).toHaveAttribute('novalidate');
  });

  it('flags empty fields under their inputs, focuses the first, and does not ask the server', async () => {
    const { signIn } = setup();
    await submit();
    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Enter your email.');
    expect(password).toHaveAccessibleDescription('Enter your password.');
    expect(email).toHaveFocus();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('focuses the password when only it is missing', async () => {
    setup();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await submit();
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('rejects a malformed email', async () => {
    setup();
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    await submit();
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(/look like an email/);
  });

  it('clears a field’s error as soon as it is typed in', async () => {
    setup();
    await submit();
    await userEvent.type(screen.getByLabelText('Email'), 'a');
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    // The other field keeps its complaint until it is touched.
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a server error as an announced banner', async () => {
    setup('login', async () => {
      throw new ApiRequestError(401, 'invalid_credentials', 'Wrong email or password.');
    });
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password.');
  });

  it('validates the register form the same way', async () => {
    const { signUp } = setup('register');
    await submit();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(signUp).not.toHaveBeenCalled();
  });
});

describe('AuthPage selection', () => {
  it('stops a double click on the water selecting things, but not in the card', () => {
    const { container } = setup();
    const page = container.firstElementChild!;
    const onWater = fireEvent.mouseDown(page, { detail: 2 });
    expect(onWater).toBe(false); // default prevented
    const inCard = fireEvent.mouseDown(screen.getByText('Sign in to your generations.'), { detail: 2 });
    expect(inCard).toBe(true);
    expect(fireEvent.mouseDown(page, { detail: 1 })).toBe(true);
  });
});
