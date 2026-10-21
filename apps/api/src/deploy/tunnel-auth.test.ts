import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../db.js',()=>({query:vi.fn(),queryOne:vi.fn()}));
import {queryOne} from '../db.js';
import tunnelRoutes from './tunnel.js';
afterEach(()=>vi.resetAllMocks());
it('refuses missing, invalid, and browser-origin credentials before upgrading',async()=>{
 const app=Fastify();await app.register(websocket);await app.register(tunnelRoutes);
 for(const headers of [{},{'x-rippel-agent-token':'invalid'},{'x-rippel-agent-token':'secret',origin:'https://attacker.example'}]){
  expect((await app.inject({url:'/deployments/tunnel',headers})).statusCode).toBe(401);
 }
 expect(queryOne).toHaveBeenCalledTimes(1);await app.close();
});
