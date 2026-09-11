import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ queryOne: vi.fn() }));
vi.mock('../deploy/agent-client.js', async () => ({ ...await vi.importActual('../deploy/agent-client.js'), agentClient: { task: vi.fn(), approveModelHost: vi.fn() } }));
import { queryOne } from '../db.js';
import { agentClient } from '../deploy/agent-client.js';
import { hostApprovalRoutes } from './host-approval.js';
const endpoint = '/backends/backend/models/installs/install/host-approval';
async function app(admin = true) {
  const server = Fastify();
  server.decorate('requireAdmin', async (_req: unknown, reply: any) => { if (!admin) return reply.code(403).send(); });
  await hostApprovalRoutes(server);
  return server;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(queryOne).mockResolvedValue({ host: 'desktop', agent_port: 8189, token: 'secret', agent_task_id: 'task' });
  vi.mocked(agentClient.task).mockResolvedValue({ task: { id: 'task', status: 'running', approvalRequired: { hostname: 'cdn.example.com' } }, logOffset: 0 } as never);
});
it.each([true, false])('forwards an explicit matching choice %s', async approve => {
  const server = await app();
  const response = await server.inject({ method: 'POST', url: endpoint, payload: { hostname: 'cdn.example.com', approve } });
  expect(response.statusCode).toBe(200);
  expect(agentClient.approveModelHost).toHaveBeenCalledWith({ host: 'desktop', agentPort: 8189, token: 'secret' }, 'task', { hostname: 'cdn.example.com', approve });
  expect(vi.mocked(queryOne).mock.calls[0]![1]).toEqual(['install', 'backend']);
  await server.close();
});
it('requires an administrator before contacting the agent', async () => {
  const server = await app(false);
  expect((await server.inject({ method: 'POST', url: endpoint, payload: { hostname: 'cdn.example.com', approve: true } })).statusCode).toBe(403);
  expect(queryOne).not.toHaveBeenCalled(); await server.close();
});
it('refuses arbitrary or stale hosts', async () => {
  const server = await app();
  expect((await server.inject({ method: 'POST', url: endpoint, payload: { hostname: 'other.example.com', approve: true } })).statusCode).toBe(409);
  expect(agentClient.approveModelHost).not.toHaveBeenCalled(); await server.close();
});
it('requires a boolean decision and a live matching install', async () => {
  const server = await app();
  expect((await server.inject({ method: 'POST', url: endpoint, payload: { hostname: 'cdn.example.com', approve: 'true' } })).statusCode).toBe(400);
  vi.mocked(queryOne).mockResolvedValue(null);
  expect((await server.inject({ method: 'POST', url: endpoint, payload: { hostname: 'cdn.example.com', approve: true } })).statusCode).toBe(409);
  expect(agentClient.approveModelHost).not.toHaveBeenCalled(); await server.close();
});
