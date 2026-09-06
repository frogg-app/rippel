import { createContext, useContext } from 'react';
import type { User } from '@comfy/shared';
import type { Credentials, Registration } from '../lib/api';

/**
 * `loading` exists so the shell never flashes the sign-in screen at a user who
 * is in fact signed in: the session lives in an httpOnly cookie, so the only
 * way to know is to ask the server, and until it answers we know nothing.
 */
export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface AuthState {
  status: AuthStatus;
  user: User | null;
  /** Whether the server will accept a sign-up right now. */
  allowRegistration: boolean;
  signIn: (credentials: Credentials) => Promise<void>;
  signUp: (registration: Registration) => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error('useAuth must be used inside <AuthProvider>');
  return state;
}
