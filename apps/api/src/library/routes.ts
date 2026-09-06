/**
 * Library metadata routes.
 *
 * Note the namespace. `/api/assets/:id` and `/api/assets/:id/thumb` already
 * exist and serve *bytes* (storage/routes.ts); everything here is metadata and
 * lives under `/api/library` so the two can never collide.
 *
 * These handlers are deliberately thin. All of the ownership and paging logic
 * is in queries.ts, where it is unit-testable without a database; a handler's
 * only jobs are to parse input, pick a status code, and stay quiet about what
 * it did not find.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decodeCursor } from './cursor.js';
import {
  addAssetToCollection,
  createCollection,
  deleteCollection,
  getAsset,
  getAssetJobId,
  getJobForAsset,
  listAssets,
  listCollections,
  realDb,
  removeAssetFromCollection,
  setStarred,
  softDeleteAsset,
} from './queries.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const idParams = z.object({ id: z.string().uuid() });

const collectionAssetParams = z.object({
  id: z.string().uuid(),
  assetId: z.string().uuid(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
  kind: z.enum(['image', 'video']).optional(),
  // Query strings carry text, so accept the two spellings a browser produces.
  starred: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  collectionId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(500).optional(),
});

const createCollectionBody = z.object({ name: z.string().trim().min(1).max(120) });

const patchAssetBody = z.object({ starred: z.boolean().optional() });

export default async function libraryRoutes(app: FastifyInstance) {
  const db = realDb;

  const badRequest = (message: string) => ({ error: 'invalid_input', message });
  const notFound = { error: 'not_found', message: 'No such asset.' };
  const noCollection = { error: 'not_found', message: 'No such collection.' };

  // -------------------------------------------------------------- assets

  app.get('/library/assets', { onRequest: [app.requireAuth] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send(badRequest('Bad list parameters.'));
    }
    const user = req.user!;

    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor) {
      // Restarting the scroll at the top instead would loop forever.
      return reply.code(400).send(badRequest('That page cursor is not one of ours.'));
    }

    return listAssets(db, {
      userId: user.id,
      limit: parsed.data.limit,
      cursor,
      kind: parsed.data.kind,
      starred: parsed.data.starred,
      collectionId: parsed.data.collectionId,
      q: parsed.data.q,
    });
  });

  app.get('/library/assets/:id', { onRequest: [app.requireAuth] }, async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send(badRequest('Bad asset id.'));
    const user = req.user!;

    const asset = await getAsset(db, parsed.data.id, user.id);
    if (!asset) return reply.code(404).send(notFound);

    // Read the raw column rather than trusting Asset.jobId, which flattens a
    // detached asset's null to '' for the shared type.
    const { jobId } = await getAssetJobId(db, parsed.data.id, user.id);
    const job = await getJobForAsset(db, jobId, user.id);

    return { asset, job };
  });

  app.patch('/library/assets/:id', { onRequest: [app.requireAuth] }, async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send(badRequest('Bad asset id.'));
    const body = patchAssetBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest('Bad asset patch.'));
    const user = req.user!;

    if (body.data.starred === undefined) {
      // Nothing to change: report the asset as it stands, still ownership-checked.
      const asset = await getAsset(db, parsed.data.id, user.id);
      if (!asset) return reply.code(404).send(notFound);
      return { asset };
    }

    const asset = await setStarred(db, parsed.data.id, user.id, body.data.starred);
    if (!asset) return reply.code(404).send(notFound);
    return { asset };
  });

  app.delete('/library/assets/:id', { onRequest: [app.requireAuth] }, async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send(badRequest('Bad asset id.'));
    const user = req.user!;

    const deleted = await softDeleteAsset(db, parsed.data.id, user.id);
    if (!deleted) return reply.code(404).send(notFound);
    return reply.code(204).send();
  });

  // -------------------------------------------------------------- collections

  app.get('/library/collections', { onRequest: [app.requireAuth] }, async (req) => {
    return { collections: await listCollections(db, req.user!.id) };
  });

  app.post('/library/collections', { onRequest: [app.requireAuth] }, async (req, reply) => {
    const body = createCollectionBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest('A collection needs a name.'));

    const collection = await createCollection(db, req.user!.id, body.data.name);
    return reply.code(201).send({ collection });
  });

  app.delete('/library/collections/:id', { onRequest: [app.requireAuth] }, async (req, reply) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send(badRequest('Bad collection id.'));

    const deleted = await deleteCollection(db, parsed.data.id, req.user!.id);
    if (!deleted) return reply.code(404).send(noCollection);
    return reply.code(204).send();
  });

  app.put(
    '/library/collections/:id/assets/:assetId',
    { onRequest: [app.requireAuth] },
    async (req, reply) => {
      const parsed = collectionAssetParams.safeParse(req.params);
      if (!parsed.success) return reply.code(400).send(badRequest('Bad collection or asset id.'));

      const added = await addAssetToCollection(
        db,
        parsed.data.id,
        parsed.data.assetId,
        req.user!.id,
      );
      // 404, not 403: adding an asset you do not own must not confirm that the
      // id exists. Same answer for a collection that is not yours.
      if (!added) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'No such collection or asset.' });
      }
      return reply.code(204).send();
    },
  );

  app.delete(
    '/library/collections/:id/assets/:assetId',
    { onRequest: [app.requireAuth] },
    async (req, reply) => {
      const parsed = collectionAssetParams.safeParse(req.params);
      if (!parsed.success) return reply.code(400).send(badRequest('Bad collection or asset id.'));

      const removed = await removeAssetFromCollection(
        db,
        parsed.data.id,
        parsed.data.assetId,
        req.user!.id,
      );
      if (!removed) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'No such collection or asset.' });
      }
      return reply.code(204).send();
    },
  );
}
