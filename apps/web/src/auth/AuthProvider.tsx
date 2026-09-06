import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User } from '@comfy/shared';
import { api, ApiRequestError, type Credentials, type Registration } from '../lib/api';
import { AuthContext, type AuthState, type AuthStatus } from './context';

/**
 * Holds the signed-in user for the whole app.
 *
 * There is no token to store: the session is an httpOnly cookie the browser
 * attaches on its own, which is why nothing here touches localStorage. The
 * cost of that is a round trip on boot to find out who we are.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [allowRegistration, setAllowRegistration] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // A 401 here is the expected answer for a signed-out visitor, not a
      // failure — anything else we still treat as anonymous, because the only
      // useful thing to show someone we cannot identify is the sign-in screen.
      const me = await api.auth.me().catch(() => null);
      if (cancelled) return;
      setUser(me?.user ?? null);
      setStatus(me ? 'authenticated' : 'anonymous');

      const config = await api.auth.config().catch(() => null);
      if (!cancelled) setAllowRegistration(config?.allowRegistration ?? false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (credentials: Credentials) => {
    const { user: signedIn } = await api.auth.login(credentials);
    setUser(signedIn);
    setStatus('authenticated');
  }, []);

  const signUp = useCallback(async (registration: Registration) => {
    const { user: created } = await api.auth.register(registration);
    setUser(created);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    // If the call fails the cookie may still be gone, and staying "signed in"
    // in the UI would be worse than signing out optimistically.
    await api.auth.logout().catch((error: unknown) => {
      if (!(error instanceof ApiRequestError)) throw error;
    });
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthState>(
    () => ({ status, user, allowRegistration, signIn, signUp, signOut }),
    [status, user, allowRegistration, signIn, signUp, signOut],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
