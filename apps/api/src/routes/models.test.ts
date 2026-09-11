import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { query } from '../db.js';
import modelRoutes from './models.js';

async function app() {
  const server = Fastify();
  server.decorate('requireAuth', async () => {});
  await server.register(modelRoutes);
  return server;
}

afterEach(() => vi.resetAllMocks());

describe('model availability filters', () => {
  it('accepts numeric flags sent by the Models page', async () => {
    vi.mocked(query).mockResolvedValue([]);
    const server = await app();
    const response = await server.inject('/models?runnability=1&previews=1');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ models: [], runnability: {}, previews: {} });
    await server.close();
  });

  it('restricts both models and family filters to online, enabled backend inventory', async () => {
    vi.mocked(query).mockResolvedValue([]);
    const server = await app();
    const response = await server.inject('/models?type=checkpoint&availableOnly=true');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ models: [], families: [] });
    const calls = vi.mocked(query).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [sql, params] of calls) {
      expect(sql).toContain("($2::boolean IS NOT TRUE OR (b.status = 'online' AND b.enabled))");
      expect(params?.slice(0, 2)).toEqual(['checkpoint', true]);
    }
    await server.close();
  });

  it.each(['', '?availableOnly=false', '?availableOnly=0'])('preserves historical entries for management (%s)', async (suffix) => {
    vi.mocked(query).mockResolvedValueOnce([{
      id: 'm1', type: 'checkpoint', filename: 'removed.safetensors', display_name: 'Removed',
      base_model: 'sdxl', preview_url: null, size_bytes: null, source: 'local',
      source_ref: null, backend_ids: [],
    }]).mockResolvedValueOnce([{ base_model: 'sdxl' }]);
    const server = await app();
    const response = await server.inject(`/models${suffix}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().models[0]).toMatchObject({ filename: 'removed.safetensors', backendIds: [] });
    expect(response.json().families).toEqual(['sdxl']);
    for (const [, params] of vi.mocked(query).mock.calls) expect(params?.[1]).toBe(false);
    await server.close();
  });

  it('rejects ambiguous availability flags before querying inventory', async () => {
    const server = await app();
    const response = await server.inject('/models?availableOnly=maybe');
    expect(response.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
    await server.close();
  });
});
