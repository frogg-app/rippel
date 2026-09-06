import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RedirectIfSignedIn, RequireAuth } from './auth/RequireAuth';
import { AppShell } from './shell/AppShell';
import { AuthPage } from './routes/AuthPage';
import { CreatePage } from './routes/CreatePage';
import { LibraryPage } from './routes/LibraryPage';
import { ModelsPage } from './routes/ModelsPage';
import { NotFoundPage } from './routes/NotFoundPage';

/**
 * Routes.
 *
 *   /login, /register   the auth screens — the only pages without the shell
 *   /create             the creation surface (the default landing place)
 *   /                   → /create
 *
 * Every tab in the shell now leads somewhere, so
 * adding them later is a route and a screen, not a change to the chrome.
 */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<RedirectIfSignedIn />}>
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
          </Route>

          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<Navigate to="/create" replace />} />
              <Route path="/create" element={<CreatePage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
