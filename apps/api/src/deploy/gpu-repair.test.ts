/**
 * The admin's one-click "Repair GPU setup": the API hands it to the agent,
 * which tests the GPU and swaps torch builds as a task.
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '@comfy/shared';
import { makeDeploymentRoutes, type DeployDb } from './routes.js';
import type { AgentClient } from './agent-client.js';

const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROW = {
  id: D1, name: 'steve-pc', host: '203.0.113.5', agent_port: 8189, agent_url: null, engine_url: null,
  platform: 'win32', status: 'online', token: 'tok', agent_version: '0.4.14', comfy: null,
  backend_id: null, backend_name: null, last_seen_at: new Date(), created_at: new Date(),
};

async function build(role: 'admin' | 'user', repairGpu: AgentClient['repairGpu']) {
  const db = {
    query: (async (sql: string, params: unknown[] = []) =>
      sql.includes('FROM deployments d') && params[0] === D1 ? [ROW] : []) as DeployDb['query'],
    queryOne: (async (sql: string, params: unknown[] = []) =>
      sql.includes('FROM deployments d') && params[0] === D1 ? ROW : null) as DeployDb['queryOne'],
  } as DeployDb;
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => { (req as FastifyRequest & { user: unknown }).user = { id: 'u', role }; });
  const gate = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user?.role !== 'admin') await reply.code(403).send({ error: 'forbidden' });
  };
  app.decorate('requireAuth', async () => {});
  app.decorate('requireSettings', gate);
  app.decorate('requireAdmin', gate);
  await app.register(makeDeploymentRoutes({ db, agent: { repairGpu } as unknown as AgentClient, pollNow: async () => {} }));
  await app.ready();
  return app;
}

describe('POST /deployments/:id/gpu/repair', () => {
  it('starts the agent task for an admin', async () => {
    const task = { id: 't1', kind: 'repair-gpu', status: 'running' } as unknown as AgentTask;
    const repairGpu = vi.fn(async () => task);
    const app = await build('admin', repairGpu);
    const res = await app.inject({ method: 'POST', url: `/deployments/${D1}/gpu/repair` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ task });
    expect(repairGpu).toHaveBeenCalledOnce();
  });

  it('is admin-only', async () => {
    const repairGpu = vi.fn();
    const app = await build('user', repairGpu);
    const res = await app.inject({ method: 'POST', url: `/deployments/${D1}/gpu/repair` });
    expect(res.statusCode).toBe(403);
    expect(repairGpu).not.toHaveBeenCalled();
  });
});
