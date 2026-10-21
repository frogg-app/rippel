import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
vi.mock('../auth/sessions.js',()=>({resolveSession:vi.fn()}));
import { resolveSession } from '../auth/sessions.js';
import authPlugin from './auth.js';
it.each([
  [null,401,401],
  [{role:'user',settingsAccess:false},403,403],
  [{role:'user',settingsAccess:true},200,403],
  [{role:'admin',settingsAccess:false},200,200],
] as const)('separates backend settings from administrator access for %j',async(user,settings,admin)=>{
  vi.mocked(resolveSession).mockResolvedValue(user as never);
  const app=Fastify();await app.register(authPlugin);
  app.get('/settings',{onRequest:[app.requireSettings]},async()=>({ok:true}));
  app.get('/admin',{onRequest:[app.requireAdmin]},async()=>({ok:true}));
  try { expect((await app.inject('/settings')).statusCode).toBe(settings);expect((await app.inject('/admin')).statusCode).toBe(admin); }
  finally {await app.close();}
});
