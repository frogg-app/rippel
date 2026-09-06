import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { env, assertStorageConfigured } from './env.js';
import { migrate, pool, waitForDatabase } from './db.js';
import { seed } from './seed.js';
import { pruneSessions } from './auth/sessions.js';
import { startBackendPoller } from './lib/backend-poller.js';
import { startInstallPoller } from './models/install-poller.js';
import { startOrchestrator } from './orchestrator/runner.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import backendRoutes from './routes/backends.js';
import healthRoutes from './routes/health.js';
import modelRoutes from './routes/models.js';
import assetRoutes from './storage/routes.js';
import modelInstallRoutes from './models/routes.js';
import jobRoutes from './orchestrator/routes.js';
import libraryRoutes from './library/routes.js';
import uploadRoutes from './uploads/routes.js';

const app = Fastify({
  logger: {
    level: env.isProduction ? 'info' : 'debug',
    transport: env.isProduction ? undefined : { target: 'pino-pretty' },
  },
  // The web app and api sit behind the same reverse proxy, which sets these.
  trustProxy: true,
  bodyLimit: 32 * 1024 * 1024,
});

await app.register(cookie, { secret: env.authSecret });
await app.register(authPlugin);
// Job progress is pushed over a socket rather than polled; see orchestrator/routes.ts.
await app.register(websocket);

await app.register(
  async (api) => {
    await api.register(healthRoutes);
    await api.register(authRoutes);
    await api.register(backendRoutes);
    await api.register(modelRoutes);
    await api.register(assetRoutes);
    await api.register(modelInstallRoutes);
    await api.register(jobRoutes);
    await api.register(libraryRoutes);
    await api.register(uploadRoutes);
  },
  { prefix: '/api' },
);

app.setErrorHandler((err: FastifyError, req, reply) => {
  req.log.error({ err }, 'request failed');
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  reply.code(status).send({
    error: status === 500 ? 'internal' : err.code ?? 'error',
    // Never leak an internal stack or SQL error to the client.
    message: status === 500 ? 'Something went wrong on the server.' : err.message,
  });
});

async function main() {
  // Fail fast on a bad storage configuration, before any GPU time is spent.
  assertStorageConfigured();

  app.log.info('waiting for the database');
  await waitForDatabase();
  await migrate((msg) => app.log.info(msg));
  await seed((msg) => app.log.info(msg));

  const stopPoller = startBackendPoller((msg) => app.log.info(msg));
  const stopInstallPoller = startInstallPoller((msg) => app.log.info(msg));
  const stopOrchestrator = startOrchestrator((msg) => app.log.info(msg));
  const pruneTimer = setInterval(() => {
    void pruneSessions().catch((err) => app.log.warn({ err }, 'session prune failed'));
  }, 60 * 60 * 1000);

  await app.listen({ port: env.port, host: env.host });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    clearInterval(pruneTimer);
    stopPoller();
    stopInstallPoller();
    stopOrchestrator();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
});
