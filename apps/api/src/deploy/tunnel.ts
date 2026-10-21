/** Agent-initiated, authenticated multiplexed TCP tunnel. Only the agent API
 * and its local engine are addressable. The HTTP gateway binds to loopback. */
import { createServer, request as httpRequest } from 'node:http';
import { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { queryOne, query } from '../db.js';

interface Frame { type: 'open'|'opened'|'data'|'ack'|'end'|'close'; id: string; target?: 'agent'|'engine'; data?: string; error?: string }
const CHUNK=32*1024;
class TunnelStream extends Duplex {
  private idle?: ReturnType<typeof setTimeout>;
  private idleMs=0;
  setTimeout(ms:number,callback?:()=>void){this.idleMs=ms;if(callback)this.once('timeout',callback);this.touch();return this;}
  setNoDelay(){return this;}
  setKeepAlive(){return this;}
  private touch(){clearTimeout(this.idle);if(this.idleMs)this.idle=setTimeout(()=>this.emit('timeout'),this.idleMs).unref();}
  ready=false;
  start?:()=>void;
  ack?:()=>void;
  readAck=false;
  constructor(readonly id:string,readonly session:TunnelSession,readonly target:'agent'|'engine') {
    super();this.on('error',()=>{});
  }
  open(){this.session.send({type:'open',id:this.id,target:this.target});}
  _read(){if(this.readAck){this.readAck=false;this.session.send({type:'ack',id:this.id});}}
  _write(chunk:Buffer,_encoding:BufferEncoding,done:(error?:Error|null)=>void){
    this.touch();let offset=0;
    const next=()=>{if(this.destroyed)return done(new Error('Tunnel closed'));if(offset>=chunk.length)return done();
      const part=chunk.subarray(offset,offset+CHUNK);offset+=part.length;this.ack=next;
      this.session.send({type:'data',id:this.id,data:part.toString('base64')});};
    if(this.ready)next();else this.start=next;
  }
  _final(done:()=>void){this.session.send({type:'end',id:this.id});done();}
  _destroy(error:Error|null,done:(error?:Error|null)=>void){clearTimeout(this.idle);this.session.streams.delete(this.id);this.session.send({type:'close',id:this.id});done(error);}
  receive(frame:Frame){
    this.touch();
    if(frame.type==='opened'){this.ready=true;this.start?.();this.start=undefined;}
    else if(frame.type==='ack'){const ack=this.ack;this.ack=undefined;ack?.();}
    else if(frame.type==='data'){
      if(typeof frame.data!=='string'||frame.data.length>CHUNK*2)return this.destroy(new Error('Invalid tunnel frame'));
      if(this.push(Buffer.from(frame.data,'base64')))this.session.send({type:'ack',id:this.id});else this.readAck=true;
    }else if(frame.type==='end')this.push(null);
    else if(frame.type==='close')this.destroy(new Error(typeof frame.error === 'string' ? frame.error.slice(0,300) : 'Agent closed tunnel channel'));
  }
}
export class TunnelSession {
  streams=new Map<string,TunnelStream>();
  constructor(readonly socket:WebSocket){
    socket.on('message',raw=>{try{const frame=JSON.parse(raw.toString()) as Frame;this.streams.get(frame.id)?.receive(frame);}catch{socket.close(1008,'Invalid frame');}});
    socket.on('close',()=>{for(const stream of this.streams.values())stream.destroy(new Error('Agent disconnected'));this.streams.clear();});
    socket.on('error',()=>{});
    let alive=true;socket.on('pong',()=>{alive=true});
    const timer=setInterval(()=>{if(!alive)return socket.terminate();alive=false;socket.ping();},20_000);timer.unref();socket.once('close',()=>clearInterval(timer));
  }
  send(frame:Frame){if(this.socket.readyState===WebSocket.OPEN){if(this.socket.bufferedAmount>4*1024*1024){this.socket.terminate();return;}this.socket.send(JSON.stringify(frame));}}
  connect(target:'agent'|'engine'){
    if(this.socket.readyState!==WebSocket.OPEN)throw new Error('Agent tunnel is disconnected');
    if(this.streams.size>=64)throw new Error('Agent tunnel has too many active connections');
    const stream=new TunnelStream(randomUUID(),this,target);this.streams.set(stream.id,stream);stream.open();return stream;
  }
}
const sessions=new Map<string,TunnelSession>();
const tokens=new Map<string,string>();
let gatewayPort=Number(process.env.RIPPEL_TUNNEL_PORT ?? 4001);
export async function restoreTunnelTargets() {
  const rows = await query<{id:string;token:string;agent_version:string|null}>('SELECT id, token, agent_version FROM deployments');
  for (const row of rows) {
    const [major, minor] = (row.agent_version ?? '0.0').split('.').map(Number);
    if (major! > 0 || (major === 0 && minor! >= 4)) tokens.set(row.token, row.id);
  }
}
export function tunnelConnected(id:string){return sessions.get(id)?.socket.readyState===WebSocket.OPEN;}
export function tunnelEngineUrl(id:string){return `http://127.0.0.1:${gatewayPort}/${id}/engine`;}
export function tunnelAgentUrl(token:string){const id=tokens.get(token);return id ? `http://127.0.0.1:${gatewayPort}/${id}/agent` : null;}
export function attachTunnel(id:string,token:string,socket:WebSocket){
  sessions.get(id)?.socket.close(1000,'Replaced by a new agent connection');
  const session=new TunnelSession(socket);sessions.set(id,session);tokens.set(token,id);
  socket.once('close',()=>{if(sessions.get(id)===session)sessions.delete(id);});
}
export function disconnectTunnel(id:string){sessions.get(id)?.socket.close(1000,'Backend removed');sessions.delete(id);for(const [token,owner] of tokens)if(owner===id)tokens.delete(token);}
export async function startTunnelGateway(port=gatewayPort){
  const resolve=(url:string|undefined)=>{const match=/^\/([\w-]+)\/(agent|engine)(\/.*)?$/.exec(url??'');if(!match)return null;
    const session=sessions.get(match[1]!);return session?{session,target:match[2] as 'agent'|'engine',path:match[3]??'/'}:null;};
  const server=createServer((req,res)=>{
    const route=resolve(req.url);if(!route){res.writeHead(503);res.end('Agent tunnel is disconnected');return;}
    try{
      const stream=route.session.connect(route.target);
      const upstream=httpRequest({host:'127.0.0.1',path:route.path,method:req.method,headers:{...req.headers,host:'127.0.0.1',connection:'close'},createConnection:()=>stream as never},response=>{
        res.writeHead(response.statusCode??502,response.headers);response.pipe(res);response.on('end',()=>stream.destroy());response.on('error',()=>{stream.destroy();res.destroy();});
      });
      upstream.on('error',(error)=>{console.warn('Tunnel upstream failure',route.target,route.path.split('?')[0],error.message,'active channels',route.session.streams.size);stream.destroy();if(!res.headersSent)res.writeHead(502);res.end('Agent tunnel request failed');});
      upstream.setTimeout(120_000,()=>upstream.destroy(new Error('Agent response timed out')));
      req.on('aborted',()=>upstream.destroy());res.on('close',()=>{if(!res.writableFinished)upstream.destroy();});req.pipe(upstream);
    }catch(error){console.warn('Tunnel unavailable',String(error));res.writeHead(503);res.end('Agent tunnel is unavailable');}
  });
  server.on('upgrade',(req,socket,head)=>{
    const route=resolve(req.url);if(!route){socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');return;}
    try {const upstream=route.session.connect(route.target);
      upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
      const headers=Object.entries({...req.headers,host:'127.0.0.1'}).flatMap(([k,v])=>v===undefined?[]:[`${k}: ${Array.isArray(v)?v.join(', '):v}`]);
      upstream.write(`${req.method} ${route.path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);
    }catch{socket.destroy();}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve());});
  gatewayPort=(server.address() as {port:number}).port;
  return async()=>{for(const session of sessions.values())session.socket.terminate();sessions.clear();tokens.clear();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};
}
export default async function tunnelRoutes(app:FastifyInstance){
  app.get('/deployments/tunnel',{websocket:true,preValidation:async(req,reply)=>{
    const token=req.headers['x-rippel-agent-token'];
    if(typeof token!=='string'||req.headers.origin)return reply.code(401).send();
    const row=await queryOne<{id:string}>('SELECT id FROM deployments WHERE token=$1',[token]);
    if(!row)return reply.code(401).send();
    (req as typeof req & {tunnelId:string}).tunnelId=row.id;
  }},(socket,req)=>{
    const id=(req as typeof req & {tunnelId:string}).tunnelId;
    attachTunnel(id,req.headers['x-rippel-agent-token'] as string,socket);
    void query('UPDATE backends SET base_url=$2 WHERE id=(SELECT backend_id FROM deployments WHERE id=$1)',[id,tunnelEngineUrl(id)]).catch(error=>app.log.error(error));
  });
}
