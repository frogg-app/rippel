import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './context';
import { Splash } from '../components/Splash';

/**
 * The gate in front of every real screen: anonymous visitors get the sign-in
 * screen, and the page they were trying to reach is remembered in location
 * state so signing in puts them back where they meant to be.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Splash />;
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

/** The mirror image: a signed-in user has no business on the auth screens. */
export function RedirectIfSignedIn() {
  const { status } = useAuth();
  if (status === 'loading') return <Splash />;
  if (status === 'authenticated') return <Navigate to="/create" replace />;
  return <Outlet />;
}
