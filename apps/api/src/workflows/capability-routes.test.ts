/**
 * `GET /api/workflows` — the family/capability projection the Create screen
 * reads instead of guessing.
 *
 * Two things are worth pinning here, and they are not the literal payload:
 *
 *  1. **It cannot drift from the resolver.** Every answer is asserted against
 *     `findTemplate`, which is what a dispatch calls. A projection that agreed
 *     with the registry only on the day it was written would be the hardcoded
 *     client mirror again, one layer down.
 *  2. **It leaks no graph.** The manifest carries JSON paths into node graphs,
 *     node class names and constraint tables. PLAN.md's rule is that the
 *     frontend does not change when a family is added, which holds only while
 *     the frontend cannot see a node — so the absence is a test, not a habit.
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { WorkflowCapabilities } from '@comfy/shared';
import workflowCapabilityRoutes, { buildWorkflowCapabilities } from './routes.js';
import { TEMPLATES, findTemplate, normalizeBaseModel } from './registry.js';

async function server(authed = true) {
  const app = Fastify();
  app.decorate('requireAuth', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!authed) return reply.code(401).send({ error: 'unauthorized' });
  });
  await app.register(workflowCapabilityRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('GET /workflows', () => {
  it('needs a session, like GET /models', async () => {
    const app = await server(false);
    const res = await app.inject({ method: 'GET', url: '/api/workflows' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('answers exactly what findTemplate would pick, for every family', async () => {
    const payload = buildWorkflowCapabilities();

    for (const entry of payload.families) {
      for (const offer of entry.offers) {
        const resolved = findTemplate(offer.capability, entry.label);
        expect(resolved, `${entry.family}/${offer.capability}`).toBeDefined();
        expect(resolved!.manifest.id).toBe(offer.templateId);
        expect(offer.isFallback).toBe(resolved!.manifest.isFallback === true);
      }
    }
  });

  it('lists every alias a manifest claims, folded the way the client folds it', async () => {
    const payload = buildWorkflowCapabilities();
    const listed = new Set(payload.families.map((f) => f.family));

    for (const template of TEMPLATES) {
      for (const alias of template.manifest.baseModels) {
        expect(listed, alias).toContain(normalizeBaseModel(alias));
      }
    }
    // The fold is the contract with the browser: keys are lowercase alnum.
    for (const family of listed) expect(family).toMatch(/^[a-z0-9]+$/);
  });

  it('reports the generic graphs for a model whose family we could not infer', async () => {
    const payload = buildWorkflowCapabilities();
    // Not an empty list: an unrecognised checkpoint gets the generic SD graph,
    // and a client that read this as "unrunnable" would hide ordinary merges.
    expect(payload.unknownFamily.map((o) => o.capability).sort()).toEqual(['img2img', 'txt2img']);
    expect(payload.unknownFamily.every((o) => o.isFallback)).toBe(true);
  });

  it('keeps families with no workflow out of the map entirely', async () => {
    const payload = buildWorkflowCapabilities();
    const listed = new Set(payload.families.map((f) => f.family));
    // The absence is the signal the picker hides on, so a stray alias
    // appearing here would silently make an unrunnable model look runnable.
    // FLUX rather than SVD: SVD gained a real img2vid template, and picking a
    // family that merely happens to be unimplemented today makes this test a
    // tripwire for adding workflows. FLUX is explicitly excluded from the
    // generic fallback — it needs a different loader and dual CLIP — so its
    // absence is a property of the design rather than a gap someone will close
    // by accident.
    expect(listed.has('flux1')).toBe(false);
  });

  it('sends no part of a node graph', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/workflows' });
    expect(res.statusCode).toBe(200);
    const body = res.body;

    // Node class names, graph paths and manifest internals, by name.
    for (const leak of [
      'CheckpointLoaderSimple',
      'KSampler',
      'class_type',
      'inputs',
      'requiredNodeClasses',
      'outputNodeId',
      'resolutions',
      'nodeId',
      '.inputs.',
    ]) {
      expect(body, leak).not.toContain(leak);
    }

    const parsed = JSON.parse(body) as WorkflowCapabilities;
    expect(parsed.families.length).toBeGreaterThan(0);
    await app.close();
  });

  it('serves a strong ETag and answers a revalidation with 304', async () => {
    const app = await server();
    const first = await app.inject({ method: 'GET', url: '/api/workflows' });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(first.headers['cache-control']).toContain('private');

    const second = await app.inject({
      method: 'GET',
      url: '/api/workflows',
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    await app.close();
  });
});
