/**
 * Bodiless POSTs (Test, Refresh, Get a version that works…) send no
 * content-type. Through the Cloudflare tunnel over HTTP/2 they can still
 * arrive with `transfer-encoding: chunked`, which Fastify reads as a body of
 * unknown type and refuses with a bare 415 "Unsupported Media Type". This
 * catch-all accepts an empty body as no body, and refuses a real body of an
 * unknown type with a message that says what to send.
 */
import type { FastifyInstance } from 'fastify';

export function acceptEmptyBodies(app: FastifyInstance): void {
  app.addContentTypeParser('*', (request, payload, done) => {
    let size = 0;
    payload.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });
    payload.on('error', done);
    payload.on('end', () => {
      if (size === 0) return done(null, undefined);
      const type = request.headers['content-type'] ?? 'no content type';
      const error = Object.assign(new Error(`Send this request as JSON (it arrived as ${type}).`), {
        statusCode: 415,
      });
      done(error, undefined);
    });
  });
}
