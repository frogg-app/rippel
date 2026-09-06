import { defineConfig } from 'vitest/config';

/**
 * Node environment, no globals: tests import `describe`/`it`/`expect` explicitly
 * so a test file reads the same as any other module and needs no ambient types
 * in the app's tsconfig.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // env.ts validates these at import time and throws without them, and the
    // module graph of almost any test reaches it via db.ts. Nothing here is
    // ever connected to: the storage tests use a temp directory and a fake
    // database, and the compiler tests touch neither.
    env: {
      AUTH_SECRET: 'test-secret-not-used-for-anything',
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      STORAGE_LOCAL_PATH: '/tmp/comfy-studio-test-assets',
      // Deliberately tiny: the upload route test has to send a file that
      // exceeds the cap, and 20 MB of noise through the multipart parser is
      // slow for no extra coverage.
      UPLOAD_MAX_BYTES: '65536',
    },
  },
});
