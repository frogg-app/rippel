// `vitest/config` re-exports Vite's own defineConfig with the `test` block
// typed, so the dev server and the test runner stay in one file.
import { defineConfig } from 'vitest/config';
// loadEnv lives in vite itself; vitest/config only re-exports defineConfig.
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const { version: appVersion } = createRequire(import.meta.url)('../../package.json') as { version: string };

/**
 * The app only ever talks to same-origin `/api/*` (see src/lib/api.ts), so in
 * production a single reverse proxy fronts both the static build and the API
 * and no CORS or cookie-domain problem exists. Dev has to reproduce that:
 * this proxy makes the Vite origin serve `/api` from the Fastify server, which
 * is why the session cookie (SameSite=Lax, host-only) works in dev unchanged.
 *
 * The target is a *server-side* address — it is resolved by the Vite process,
 * not the browser — so loopback is correct here even though this box is
 * headless and everything user-facing must use the LAN IP (192.168.1.9).
 */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:4000';

/**
 * Which Host headers the dev server will answer to.
 *
 * Vite's check exists to stop a hostile page rebinding DNS at your dev server,
 * which is a real protection worth keeping. But this is self-hosted software:
 * the hostname is whatever the person running it chose, so it cannot be a
 * constant in the repo, and refusing everything unfamiliar means a reverse
 * proxy or tunnel fails with a message about a file they have never opened.
 *
 * So it is derived, not hardcoded:
 *   PUBLIC_URL          the address this install is reached at — usually enough
 *   DEV_ALLOWED_HOSTS   comma-separated extras, for more than one name
 *   DEV_ALLOW_ANY_HOST  'true' to accept anything, for anyone whose setup makes
 *                       the above impractical. Opt-in, so the protection is
 *                       only given up deliberately.
 * Loopback and LAN literals are always allowed, since that is how it is reached
 * before anyone has configured anything.
 */
function devAllowedHosts(env: Record<string, string>): true | string[] {
  if (env.DEV_ALLOW_ANY_HOST === 'true') return true;

  const hosts = new Set<string>(['localhost', '127.0.0.1', '[::1]']);

  const fromPublicUrl = env.PUBLIC_URL;
  if (fromPublicUrl) {
    try {
      hosts.add(new URL(fromPublicUrl).hostname);
    } catch {
      // A malformed PUBLIC_URL should not stop the dev server booting.
    }
  }

  for (const extra of (env.DEV_ALLOWED_HOSTS ?? '').split(',')) {
    const host = extra.trim();
    if (host) hosts.add(host);
  }

  return [...hosts];
}

// The repo's own .env is the one an operator edits, and it is not prefixed
// VITE_ — so load it with an empty prefix rather than making them duplicate
// settings into the shell. The third argument is what turns that on.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, new URL('../../', import.meta.url).pathname, ''), ...process.env } as Record<string, string>;

  return {
  plugins: [react()],
  // The About section shows this; it is the root package's version.
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: {
    // Bound to all interfaces: the box is reached over SSH from another
    // machine, so a loopback-only dev server would be unreachable.
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: devAllowedHosts(env),
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: true,
    },
  };
});
