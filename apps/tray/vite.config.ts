import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The tray is a second front end for the same product, so it borrows the web
 * app's tokens, fonts and mark directly rather than copying them: `@web` points
 * at apps/web/src, and the fonts are read from apps/web/public.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@web': fileURLToPath(new URL('../web/src', import.meta.url)) } },
  // Tauri expects a fixed port in dev and fails rather than picking another.
  server: { host: '0.0.0.0', port: 5180, strictPort: true, fs: { allow: ['..'] } },
  clearScreen: false,
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
