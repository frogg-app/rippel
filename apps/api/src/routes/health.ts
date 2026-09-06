import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';

export default async function healthRoutes(app: FastifyInstance) {
  /** Liveness: the process is up. Used by the container health check. */
  app.get('/health', async () => ({ ok: true }));

  /** Readiness: the process can actually serve requests. */
  app.get('/health/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, database: 'up' };
    } catch (err) {
      return reply.code(503).send({
        ok: false,
        database: 'down',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
