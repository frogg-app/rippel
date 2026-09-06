import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { resolveSession, type SessionUser } from '../auth/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, or null. Populated on every request. */
    user: SessionUser | null;
  }
  interface FastifyInstance {
    /** Preflight handler: 401s anonymous requests. */
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Preflight handler: 401s anonymous, 403s non-admins. */
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Every route gets `request.user`. Authorisation is never inferred from the
 * route path — queries scope by `request.user.id` explicitly.
 */
export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    req.user = await resolveSession(req);
  });

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' });
    }
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' });
      return;
    }
    if (req.user.role !== 'admin') {
      await reply
        .code(403)
        .send({ error: 'forbidden', message: 'This needs an administrator account.' });
    }
  });
});
