import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { acceptEmptyBodies } from './empty-body.js';

async function app() {
  const server = Fastify();
  acceptEmptyBodies(server);
  server.post('/x', async (request) => ({ body: request.body ?? null }));
  await server.ready();
  return server;
}

describe('acceptEmptyBodies', () => {
  it('treats a chunked POST with no body and no content type as no body', async () => {
    const server = await app();
    const res = await server.inject({ method: 'POST', url: '/x', headers: { 'transfer-encoding': 'chunked' }, payload: '' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null });
  });

  it('still parses JSON', async () => {
    const server = await app();
    const res = await server.inject({ method: 'POST', url: '/x', payload: { a: 1 } });
    expect(res.json()).toEqual({ body: { a: 1 } });
  });

  it('refuses a real body of an unknown type with a clear message', async () => {
    const server = await app();
    const res = await server.inject({ method: 'POST', url: '/x', headers: { 'content-type': 'application/x-thing' }, payload: 'hi' });
    expect(res.statusCode).toBe(415);
    expect(res.json().message).toMatch(/Send this request as JSON/);
  });
});
