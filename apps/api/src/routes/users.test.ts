import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from '../db.js';
import userRoutes from './users.js';
const id = '11111111-1111-4111-8111-111111111111';
const row = { id, email: 'user@example.com', display_name: 'User', role: 'user', settings_access: false, suspended: false, generation_enabled: true, max_queued_jobs: null, daily_generation_limit: null, created_at: new Date() };
const permissions = { role: 'user', settingsAccess: true, suspended: false, generationEnabled: true, maxQueuedJobs: 2, dailyGenerationLimit: 10 };
const client = { query: vi.fn() };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(transaction).mockImplementation(async fn => fn(client as never)); });
async function server(admin = true) {
  const app = Fastify();
  app.decorate('requireAdmin', async (req: { user?: unknown }, reply: { code: (n: number) => { send: (body: unknown) => unknown } }) => {
    if (!admin) { reply.code(403).send({ message: 'Administrator required.' }); return; }
    req.user = { id, role: 'admin' };
  });
  await app.register(userRoutes); return app;
}
it('denies non-admins both listing and updating users', async () => {
  const app=await server(false);
  try {
    expect((await app.inject('/users')).statusCode).toBe(403);
    expect((await app.inject({ method:'PATCH',url:`/users/${id}`,payload:permissions })).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
it('returns management fields and usage without password hashes', async () => {
  vi.mocked(query).mockResolvedValue([{...row,password_hash:'never expose',active_jobs:'2',generations_today:'7'}]);
  const app=await server();
  try { const res=await app.inject('/users');expect(res.json().users[0]).toMatchObject({activeJobs:2,generationsToday:7});expect(res.body).not.toContain('never expose'); }
  finally { await app.close(); }
});
it('protects the last active administrator before writing changes', async () => {
  client.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{role:'admin',suspended:false}]}).mockResolvedValueOnce({rows:[{...row,role:'admin'}]}).mockResolvedValueOnce({rows:[{n:'1'}]});
  const app=await server();
  try {
    const res=await app.inject({method:'PATCH',url:`/users/${id}`,payload:permissions});
    expect(res.statusCode).toBe(409);expect(res.json().message).toContain('active administrator');
    expect(client.query.mock.calls[0]![0]).toContain('LOCK TABLE users');
    expect(client.query.mock.calls.some(([sql]) => /UPDATE users/.test(sql))).toBe(false);
  } finally { await app.close(); }
});
it('suspends an account and revokes its active sessions atomically', async () => {
  client.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{role:'admin',suspended:false}]}).mockResolvedValueOnce({rows:[row]}).mockResolvedValueOnce({rows:[{...row,suspended:true}]}).mockResolvedValueOnce({rows:[]});
  const app=await server();
  try {
    const res=await app.inject({method:'PATCH',url:`/users/${id}`,payload:{...permissions,suspended:true}});
    expect(res.statusCode).toBe(200);expect(res.json().user.suspended).toBe(true);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE sessions SET revoked_at'),[id]);
  } finally { await app.close(); }
});
it('rechecks actor permissions under the account-change lock', async () => {
  client.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{role:'user',suspended:false}]});
  const app=await server();
  try { expect((await app.inject({method:'PATCH',url:`/users/${id}`,payload:permissions})).statusCode).toBe(403); }
  finally { await app.close(); }
});
it('rejects invalid limits without starting a transaction', async () => {
  const app=await server();
  try { expect((await app.inject({method:'PATCH',url:`/users/${id}`,payload:{...permissions,maxQueuedJobs:-1}})).statusCode).toBe(400);expect(transaction).not.toHaveBeenCalled(); }
  finally { await app.close(); }
});
const targetId='22222222-2222-4222-8222-222222222222';
it('denies deletion to non-admins and prevents self-deletion', async () => {
 const denied=await server(false);expect((await denied.inject({method:'DELETE',url:`/users/${targetId}`})).statusCode).toBe(403);await denied.close();
 const app=await server();expect((await app.inject({method:'DELETE',url:`/users/${id}`})).statusCode).toBe(409);expect(transaction).not.toHaveBeenCalled();await app.close();
});
it('deletes an idle account after checking permissions under lock', async () => {
 client.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{role:'admin',suspended:false}]}).mockResolvedValueOnce({rows:[{...row,id:targetId}]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]});
 const app=await server();expect((await app.inject({method:'DELETE',url:`/users/${targetId}`})).statusCode).toBe(204);expect(client.query).toHaveBeenCalledWith('DELETE FROM users WHERE id=$1',[targetId]);await app.close();
});
it('refuses deleting an account with active work', async () => {
 client.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{role:'admin',suspended:false}]}).mockResolvedValueOnce({rows:[{...row,id:targetId}]}).mockResolvedValueOnce({rows:[{n:1}]});
 const app=await server();expect((await app.inject({method:'DELETE',url:`/users/${targetId}`})).statusCode).toBe(409);expect(client.query.mock.calls.some(([sql])=>sql.startsWith('DELETE'))).toBe(false);await app.close();
});
it('protects the last administrator from deletion', async () => {
 client.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{role:'admin',suspended:false}]}).mockResolvedValueOnce({rows:[{...row,id:targetId,role:'admin'}]}).mockResolvedValueOnce({rows:[{n:'1'}]});
 const app=await server();const res=await app.inject({method:'DELETE',url:`/users/${targetId}`});expect(res.statusCode).toBe(409);expect(res.json().message).toContain('active administrator');await app.close();
});
