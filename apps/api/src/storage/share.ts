/**
 * The one way an asset leaves its owner: a share token.
 *
 * `access.ts` stays the rule for the signed-in owner, untouched. This is the
 * rule for everybody else, and it is just as dull: the token must match, and
 * the asset must currently be `link` or `public`. A private asset answers 404
 * whatever token it is asked with — that is how making something private
 * revokes the link — and a wrong token and a private asset look identical.
 *
 * The asset id never works here. Ids appear in owner-only URLs and job
 * payloads; a token is minted only when an asset is shared, so possessing one
 * is the permission.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { queryOne } from '../db.js';
import type { AssetKeyRow } from './access.js';
import { StorageNotFound } from './driver.js';
import { storage } from './index.js';

const params = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

export async function resolveSharedAsset(
  db: { queryOne: typeof queryOne },
  token: string,
): Promise<(AssetKeyRow & { visibility: string }) | null> {
  return db.queryOne<AssetKeyRow & { visibility: string }>(
    `SELECT storage_key, thumb_key, mime_type, visibility
       FROM assets
      WHERE share_token = $1 AND visibility IN ('link', 'public') AND deleted_at IS NULL`,
    [token],
  );
}

export default async function shareRoutes(app: FastifyInstance) {
  const serve = (variant: 'full' | 'thumb') =>
    async function handler(req: FastifyRequest, reply: FastifyReply) {
      const parsed = params.safeParse(req.params);
      const notFound = { error: 'not_found', message: 'No such shared asset.' };
      if (!parsed.success) return reply.code(404).send(notFound);

      const row = await resolveSharedAsset({ queryOne }, parsed.data.token);
      if (!row) return reply.code(404).send(notFound);

      const isThumb = variant === 'thumb' && !!row.thumb_key;
      const key = isThumb ? row.thumb_key! : row.storage_key;
      try {
        const object = await storage().getStream(key);
        if (object.size !== null) reply.header('content-length', object.size);
        // Not immutable, unlike the owner route: the bytes never change, but
        // whether this URL may serve them does. A short private cache keeps a
        // revoked link from living on in a CDN or proxy.
        reply.header('cache-control', 'private, max-age=60');
        reply.header('content-disposition', 'inline');
        reply.header('x-robots-tag', row.visibility === 'public' ? 'all' : 'noindex');
        reply.type((isThumb ? 'image/webp' : row.mime_type) ?? object.contentType);
        return reply.send(object.stream);
      } catch (err) {
        if (err instanceof StorageNotFound) return reply.code(404).send(notFound);
        throw err;
      }
    };

  // Deliberately no requireAuth: the token is the credential.
  app.get('/share/:token', serve('full'));
  app.get('/share/:token/thumb', serve('thumb'));
}
