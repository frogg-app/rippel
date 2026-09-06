/**
 * Serving stored assets back to the browser.
 *
 * Object storage is never public: MinIO buckets stay private and the local
 * driver's volume is not mounted by any web server. Every byte a user sees is
 * read through here, which is where ownership is enforced — see access.ts for
 * the rule itself.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { resolveAssetForRead } from './access.js';
import { StorageNotFound } from './driver.js';
import { storage } from './index.js';

const params = z.object({ id: z.string().uuid() });

export default async function assetRoutes(app: FastifyInstance) {
  const db = { query, queryOne };

  /** Both variants differ only in which key they read, so they share a handler. */
  const serve = (variant: 'full' | 'thumb') =>
    async function handler(req: FastifyRequest, reply: FastifyReply) {
      const parsed = params.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', message: 'Bad asset id.' });
      }
      // requireAuth has already run, so a user is always present here.
      const user = req.user!;

      const access = await resolveAssetForRead(db, parsed.data.id, user.id, variant);
      if (!access.ok) {
        if (access.reason === 'corrupt') {
          req.log.error(
            { assetId: parsed.data.id, key: access.key },
            'asset key sits outside its owner namespace',
          );
        }
        // Someone else's asset and a nonexistent one look the same from here.
        return reply.code(404).send({ error: 'not_found', message: 'No such asset.' });
      }

      try {
        const object = await storage().getStream(access.key);
        if (object.size !== null) reply.header('content-length', object.size);
        // private: these URLs are per-user, so a shared cache must never keep a
        // copy. immutable: the bytes behind an asset id never change.
        reply.header('cache-control', 'private, max-age=31536000, immutable');
        reply.header('content-disposition', 'inline');
        reply.type(access.contentType ?? object.contentType);
        return reply.send(object.stream);
      } catch (err) {
        if (err instanceof StorageNotFound) {
          // The row outlived its object — a restored database, a wiped volume.
          req.log.warn({ key: access.key }, 'asset row has no object behind it');
          return reply.code(404).send({ error: 'not_found', message: 'No such asset.' });
        }
        throw err;
      }
    };

  app.get('/assets/:id', { onRequest: [app.requireAuth] }, serve('full'));
  app.get('/assets/:id/thumb', { onRequest: [app.requireAuth] }, serve('thumb'));
}
