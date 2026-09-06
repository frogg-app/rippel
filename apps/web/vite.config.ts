// `vitest/config` re-exports Vite's own defineConfig with the `test` block
// typed, so the dev server and the test runner stay in one file.
import { defineConfig } from 'vitest/config';
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

export default defineConfig({
  plugins: [react()],
  // The About section shows this; it is the root package's version.
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: {
    // Bound to all interfaces: the box is reached over SSH from another
    // machine, so a loopback-only dev server would be unreachable.
    host: '0.0.0.0',
    port: 5173,
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
});
