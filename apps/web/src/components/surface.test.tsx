import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext, type AuthState } from '../auth/context';
import { RedirectIfSignedIn } from '../auth/RequireAuth';
import { surface } from './surface';

const auth = (status: AuthState['status']): AuthState => ({
  status,
  user: null,
  allowRegistration: true,
  signIn: async () => {},
  signUp: async () => {},
  signOut: async () => {},
});

function app(status: AuthState['status']) {
  return (
    <AuthContext.Provider value={auth(status)}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route element={<RedirectIfSignedIn />}>
            <Route path="/login" element={<p>login</p>} />
          </Route>
          <Route path="/create" element={<p>app</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('the sign-in transition gate', () => {
  afterEach(() => act(() => surface.set('idle')));

  it('holds the signed-in redirect while the card sinks, then lets it go', () => {
    act(() => surface.set('sinking'));
    const { rerender } = render(app('authenticated'));
    expect(screen.getByText('login')).toBeInTheDocument();
    act(() => surface.set('idle'));
    rerender(app('authenticated'));
    expect(screen.getByText('app')).toBeInTheDocument();
  });
});
