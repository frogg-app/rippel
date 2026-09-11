import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../db.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../orchestrator/preflight.js', async (original) => ({ ...await original<typeof import('../../orchestrator/preflight.js')>(), objectInfoFor: vi.fn() }));
vi.mock('./store.js', () => ({ saveImport: vi.fn(), getImported: vi.fn() }));
import { ComfyClient } from '../../lib/comfy.js';
import { queryOne } from '../../db.js';
import { objectInfoFor } from '../../orchestrator/preflight.js';
import { workflowLibrary, parseCatalogue } from './catalogue.js';
import { saveImport } from './store.js';
import routes from './routes.js';
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const backendId = '00000000-0000-4000-8000-000000000001';
async function app() {
  const server=Fastify();
  server.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers['x-admin'] !== 'yes') return reply.code(403).send();
    req.user={ id: backendId } as NonNullable<typeof req.user>;
  });
  server.decorate('requireAuth', async () => {});
  await server.register(routes);
  return server;
}
afterEach(() => vi.restoreAllMocks());
it('refuses non-admin imports before any backend or database action', async () => {
  const server=await app();
  const response=await server.inject({ method:'POST',url:'/workflow-library/import',payload:{} });
  expect(response.statusCode).toBe(403);
  expect(saveImport).not.toHaveBeenCalled();
  await server.close();
});
it('converts the explicitly enabled first-frame variant and saves an untested import', async () => {
  vi.spyOn(ComfyClient.prototype,'systemStats').mockResolvedValue({ system:{ ram_total:64*1024**3 } });
  vi.mocked(queryOne).mockResolvedValue({ id:backendId,base_url:'http://backend' });
  vi.mocked(objectInfoFor).mockResolvedValue(read('object-info'));
  vi.spyOn(workflowLibrary,'catalogue').mockResolvedValue(parseCatalogue(read('index'),'0.11.55'));
  vi.spyOn(workflowLibrary,'workflow').mockResolvedValue(read('video_wan2_2_5B_ti2v'));
  vi.mocked(saveImport).mockResolvedValue({ id:backendId } as Awaited<ReturnType<typeof saveImport>>);
  const server=await app();
  const response=await server.inject({ method:'POST',url:'/workflow-library/import',headers:{'x-admin':'yes'},
    payload:{ backendId,name:'video_wan2_2_5B_ti2v',version:'0.11.55',capability:'img2vid',family:'wan2.2-ti2v-5b',enableFirstFrame:true } });
  expect(response.statusCode,response.body).toBe(201);
  expect(response.json().assessment.status).toBe('needs-files');
  expect(vi.mocked(saveImport).mock.calls[0]![0]).toMatchObject({ library_version:'0.11.55',capability:'img2vid',manifest:{initImageNodeId:'56'} });
  await server.close();
});
