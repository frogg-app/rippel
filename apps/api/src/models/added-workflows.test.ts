import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() }));
import { query, queryOne } from '../db.js';
import { parseCatalogue, workflowLibrary } from '../library/workflows/catalogue.js';
import routes, { addedDeps, addedVerdicts } from './added-workflows.js';

const index = JSON.parse(readFileSync(new URL('../library/workflows/fixtures/index.json', import.meta.url), 'utf8'));
const modelId = '00000000-0000-4000-8000-00000000000a';
const backendId = '00000000-0000-4000-8000-00000000000b';
const workflowId = '00000000-0000-4000-8000-00000000000c';
const model = { id: modelId, filename: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', base_model: 'minimax', type: 'checkpoint' };

async function app(role: 'admin' | 'user' = 'admin') {
  const server = Fastify();
  const user = async (req: FastifyRequest) => { req.user = { id: modelId, role } as NonNullable<typeof req.user>; };
  server.decorate('requireAuth', user);
  server.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (role !== 'admin') return reply.code(403).send();
    await user(req);
  });
  await server.register(routes);
  return server;
}
const assessment = (status: string, missing = 0) => ({
  status, reasons: Array.from({ length: missing }, () => 'Missing a file.'), missingNodes: [], downloadBytes: missing ? 100 : 0,
  missingFiles: Array.from({ length: missing }, (_, i) => ({ name: `vae${i}.safetensors`, url: 'https://huggingface.co/x', directory: 'vae', paths: [] })),
});

beforeEach(() => {
  vi.spyOn(workflowLibrary, 'catalogue').mockResolvedValue(parseCatalogue(index, '0.11.55'));
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    if (sql.includes('FROM models m')) return model;
    if (sql.includes('FROM backends')) return { id: backendId, base_url: 'http://box' };
    if (sql.includes('model_added_workflows a JOIN')) return { title: 'MiniMax H3 T2V', capability: 'txt2vid', backend_id: backendId, operation_id: null, test_status: 'testing', test_result: null };
    return null;
  });
  vi.mocked(query).mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

it('suggests at most three MiniMax workflows that convert, and skips ones that do not', async () => {
  vi.spyOn(addedDeps, 'prepare').mockImplementation(async (input) =>
    ({ assessment: assessment(input.name.endsWith('_t2v') ? 'not-supported' : 'untested') }) as never);
  const server = await app();
  const response = await server.inject({ url: `/models/${modelId}/workflow-suggestions?backendId=${backendId}` });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json();
  expect(body.suggestions.length).toBeGreaterThan(0);
  expect(body.suggestions.length).toBeLessThanOrEqual(3);
  expect(body.suggestions.every((s: { name: string }) => /minimax/.test(s.name) && !s.name.endsWith('_t2v'))).toBe(true);
  expect(vi.mocked(addedDeps.prepare).mock.calls[0]![0]).toMatchObject({ checkpoint: model.filename, family: 'minimax' });
  await server.close();
});

it('gives a non-admin the panel without touching the library', async () => {
  const prepare = vi.spyOn(addedDeps, 'prepare');
  const server = await app('user');
  const body = (await server.inject({ url: `/models/${modelId}/workflow-suggestions?backendId=${backendId}` })).json();
  expect(body).toMatchObject({ canAdd: false, suggestions: [] });
  expect(prepare).not.toHaveBeenCalled();
  await server.close();
});

it('adds a workflow: imports it bound to the model, downloads its other files, links it', async () => {
  vi.spyOn(addedDeps, 'prepare').mockResolvedValue({ converted: { graph: {} }, mapping: { manifest: null, files: [], omitted: [] }, assessment: assessment('needs-files', 1) } as never);
  vi.spyOn(addedDeps, 'saveImport').mockResolvedValue({ id: workflowId } as never);
  vi.spyOn(addedDeps, 'verifiedFile').mockImplementation(async (file) => ({ ...file, sha256: 'a', sizeBytes: 100 }));
  vi.spyOn(addedDeps, 'planOperation').mockResolvedValue({ id: 'op' } as never);
  const start = vi.spyOn(addedDeps, 'startOperation').mockResolvedValue(null);
  const server = await app();
  const response = await server.inject({ method: 'POST', url: `/models/${modelId}/workflows/add`,
    payload: { backendId, name: 'video_minimax_h3_t2v', version: '0.11.55', capability: 'txt2vid' } });
  expect(response.statusCode, response.body).toBe(201);
  expect(vi.mocked(addedDeps.saveImport).mock.calls[0]![0]).toMatchObject({ family: 'minimax', capability: 'txt2vid' });
  expect(vi.mocked(query).mock.calls.some(([sql]) => String(sql).includes('INSERT INTO model_added_workflows'))).toBe(true);
  expect(start).toHaveBeenCalledWith('op');
  expect(response.json().added.phase).toBe('testing');
  await server.close();
});

it('refuses a non-admin add', async () => {
  const server = await app('user');
  const response = await server.inject({ method: 'POST', url: `/models/${modelId}/workflows/add`, payload: {} });
  expect(response.statusCode).toBe(403);
  await server.close();
});

it('turns a passed test into Will run on that machine', async () => {
  vi.mocked(query).mockResolvedValue([{ model_id: modelId, backend_id: backendId, workflow_id: workflowId, title: 'MiniMax H3 T2V', capability: 'txt2vid', family: 'minimax' }] as never);
  const verdict = (await addedVerdicts([modelId])).get(modelId)?.get(backendId);
  expect(verdict).toMatchObject({ status: 'ready', summary: 'Will run', capabilities: ['txt2vid'], templateId: `library-${workflowId}` });
});
