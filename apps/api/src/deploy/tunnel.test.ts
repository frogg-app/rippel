import {afterEach,expect,it} from 'vitest';
import {createServer} from 'node:http';
import {connect,type Socket} from 'node:net';
import WebSocket,{WebSocketServer} from 'ws';
import {attachTunnel,startTunnelGateway,tunnelEngineUrl,tunnelConnected} from './tunnel.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.reverse())await close();cleanup.length=0});
it('carries HTTP bodies and WebSocket traffic through the outbound agent socket',async()=>{
 const engine=createServer((req,res)=>{req.pipe(res)});const engineWs=new WebSocketServer({server:engine});engineWs.on('connection',ws=>ws.on('message',(data,binary)=>ws.send(data,{binary})));
 await new Promise<void>(r=>engine.listen(0,'127.0.0.1',r));const enginePort=(engine.address() as {port:number}).port;
 cleanup.push(async()=>{engineWs.clients.forEach(ws=>ws.terminate());engine.closeAllConnections();await new Promise<void>(r=>engine.close(()=>r()))});
 const remote=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise<void>(r=>remote.once('listening',r));cleanup.push(async()=>{remote.clients.forEach(ws=>ws.terminate());await new Promise<void>(r=>remote.close(()=>r()))});
 remote.on('connection',ws=>attachTunnel('backend','secret',ws));
 const stop=await startTunnelGateway(0);cleanup.push(stop);
 const agent=new WebSocket(`ws://127.0.0.1:${(remote.address() as {port:number}).port}`);
 const channels=new Map<string,Socket>();agent.on('message',raw=>{const f=JSON.parse(raw.toString());if(f.type==='open'){
  const socket=connect(enginePort,'127.0.0.1',()=>agent.send(JSON.stringify({type:'opened',id:f.id})));channels.set(f.id,socket);
  socket.on('data',data=>{socket.pause();agent.send(JSON.stringify({type:'data',id:f.id,data:data.toString('base64')}))});socket.on('end',()=>agent.send(JSON.stringify({type:'end',id:f.id})));socket.on('error',()=>{});
 }else if(f.type==='data'){channels.get(f.id)?.write(Buffer.from(f.data,'base64'),()=>agent.send(JSON.stringify({type:'ack',id:f.id})));}
 else if(f.type==='ack')channels.get(f.id)?.resume();else if(f.type==='end')channels.get(f.id)?.end();else if(f.type==='close'){channels.get(f.id)?.destroy();channels.delete(f.id)}});
 await new Promise<void>(r=>agent.once('open',r));cleanup.push(async()=>{agent.terminate();for(const socket of channels.values())socket.destroy()});
 expect(tunnelConnected('backend')).toBe(true);
 const payload='streamed payload '.repeat(20000);
 const response=await fetch(tunnelEngineUrl('backend')+'/upload/image',{method:'POST',body:payload,signal:AbortSignal.timeout(5000)});
 expect(response.status).toBe(200);expect(await response.text()).toBe(payload);
 for(let i=0;i<80;i++){const probe=await fetch(tunnelEngineUrl('backend')+'/system_stats');expect(probe.status).toBe(200);await probe.text();}
 await new Promise(r=>setTimeout(r,20));expect(channels.size).toBe(0);
 const ws=new WebSocket(tunnelEngineUrl('backend').replace('http:','ws:')+'/ws?clientId=test');cleanup.push(async()=>ws.terminate());
 await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
 const message=new Promise<string>(r=>ws.once('message',data=>r(data.toString())));ws.send('generation progress');expect(await message).toBe('generation progress');
 agent.terminate();await new Promise(r=>setTimeout(r,30));expect(tunnelConnected('backend')).toBe(false);
 expect((await fetch(tunnelEngineUrl('backend')+'/system_stats')).status).toBe(503);
},10000);
