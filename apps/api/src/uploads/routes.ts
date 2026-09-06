/**
 * Uploading a reference image, and serving it back.
 *
 * `POST /api/uploads` is multipart with a single `file` part. It is the drop
 * half of the reference picker; the library half is `/api/assets`, and the two
 * are deliberately symmetrical — an upload comes back as a `{ url, thumbUrl }`
 * pair on our own routes, exactly like an asset, so the UI can treat a file the
 * user just dropped and one of their own generations as the same thing.
 *
 * Nothing here trusts the request: the size cap is enforced on the stream
 * before a whole file is ever in memory, and what the file *is* comes from
 * decoding it, never from the filename or the declared content-type.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { env } from '../env.js';
import { StorageNotFound } from '../storage/driver.js';
import { storage } from '../storage/index.js';
import { resolveUploadForRead } from './access.js';
import { storeUpload, UploadRejected } from './store.js';

const params = z.object({ id: z.string().uuid() });

/** Fastify's own code for a part that hit `limits.fileSize`. */
const FILE_TOO_LARGE = 'FST_REQ_FILE_TOO_LARGE';

export default async function uploadRoutes(app: FastifyInstance) {
  const db = { query, queryOne };

  // Registered inside this plugin rather than at the root, so multipart parsing
  // exists only on the one route that wants it and cannot become an accidental
  // body parser for the rest of the API.
  await app.register(multipart, {
    limits: {
      // The real cap. Enforced by the stream parser, so an oversized upload is
      // aborted mid-transfer instead of being buffered and then rejected.
      fileSize: env.uploads.maxBytes,
      files: 1,
      fields: 4,
      fieldSize: 1024,
    },
  });

  app.post('/uploads', { onRequest: [app.requireAuth] }, async (req, reply) => {
    // requireAuth has already run, so a user is always present here.
    const user = req.user!;

    let part: Awaited<ReturnType<FastifyRequest['file']>>;
    try {
      part = await req.file();
    } catch (err) {
      if (isCode(err, 'FST_INVALID_MULTIPART_CONTENT_TYPE')) {
        return reply.code(400).send({
          error: 'invalid_input',
          message: 'Send the image as multipart/form-data with a "file" part.',
        });
      }
      throw err;
    }

    if (!part) {
      return reply
        .code(400)
        .send({ error: 'invalid_input', message: 'No file was sent.' });
    }
    if (part.fieldname !== 'file') {
      return reply.code(400).send({
        error: 'invalid_input',
        message: `Expected the image in a "file" part, got "${part.fieldname}".`,
      });
    }

    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch (err) {
      if (isCode(err, FILE_TOO_LARGE)) return tooLarge(reply);
      throw err;
    }
    // Belt and braces: with `throwFileSizeLimit` off in some future config the
    // parser truncates silently instead, and a truncated image would otherwise
    // be stored as a corrupt one.
    if (part.file.truncated) return tooLarge(reply);

    try {
      const upload = await storeUpload({ userId: user.id, bytes, db });
      req.log.info(
        { uploadId: upload.id, bytes: bytes.byteLength, mimeType: upload.mimeType },
        'stored upload',
      );
      return reply.code(201).send({ upload });
    } catch (err) {
      if (err instanceof UploadRejected) {
        // 413 for a file that is simply too big; 400 for one we will never take
        // however small it is. The client shows both, but only the second means
        // "pick a different file".
        const status = err.code === 'too_large' || err.code === 'too_many_pixels' ? 413 : 400;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  /**
   * Reading one back. Same ownership rule and same caching as `storage/routes.
   * ts` serves assets under — see the note there on why object storage is never
   * public and every byte goes through a handler that knows who is asking.
   */
  const serve = (variant: 'full' | 'thumb') =>
    async function handler(req: FastifyRequest, reply: FastifyReply) {
      const parsed = params.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', message: 'Bad upload id.' });
      }
      const user = req.user!;

      const access = await resolveUploadForRead(db, parsed.data.id, user.id, variant);
      if (!access.ok) {
        if (access.reason === 'corrupt') {
          req.log.error(
            { uploadId: parsed.data.id, key: access.key },
            'upload key sits outside its owner namespace',
          );
        }
        // Someone else's upload and a nonexistent one look the same from here.
        return reply.code(404).send({ error: 'not_found', message: 'No such upload.' });
      }

      try {
        const object = await storage().getStream(access.key);
        if (object.size !== null) reply.header('content-length', object.size);
        reply.header('cache-control', 'private, max-age=31536000, immutable');
        reply.header('content-disposition', 'inline');
        reply.type(access.contentType ?? object.contentType);
        return reply.send(object.stream);
      } catch (err) {
        if (err instanceof StorageNotFound) {
          req.log.warn({ key: access.key }, 'upload row has no object behind it');
          return reply.code(404).send({ error: 'not_found', message: 'No such upload.' });
        }
        throw err;
      }
    };

  app.get('/uploads/:id', { onRequest: [app.requireAuth] }, serve('full'));
  app.get('/uploads/:id/thumb', { onRequest: [app.requireAuth] }, serve('thumb'));
}

function tooLarge(reply: FastifyReply) {
  const mb = (env.uploads.maxBytes / (1024 * 1024)).toFixed(0);
  return reply
    .code(413)
    .send({ error: 'too_large', message: `That file is too big; the limit is ${mb} MB.` });
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}
