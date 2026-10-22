import { expect, it, vi } from 'vitest';
import { AgentError, makeAgentClient } from './agent-client.js';

const target = { host: 'gpu', agentPort: 8189, token: 'secret' };
it('sends move and checksum-verified download requests with the existing agent token', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ task: { id: 'task' } }), { status: 202 }));
  const client = makeAgentClient({ fetchImpl });
  const move = { from: 'checkpoints/model', to: 'diffusion_models/model' };
  const download = { url: 'https://huggingface.co/repo/model', path: 'vae/model', sha256: 'a'.repeat(64), sizeBytes: 123 };
  expect(await client.moveModel(target, move)).toEqual({ id: 'task' });
  expect(await client.downloadModel(target, download)).toEqual({ id: 'task' });
  for (const [index, [url, init]] of fetchImpl.mock.calls.entries()) {
    expect(url).toBe(`http://gpu:8189/agent/models/${index === 0 ? 'move' : 'download'}`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'X-Rippel-Agent-Token': 'secret' } });
    expect(JSON.parse(init!.body as string)).toEqual(index === 0 ? move : download);
  }
});

it('preserves agent refusals so the card can explain a failed operation', async () => {
  const client = makeAgentClient({ fetchImpl: async () => new Response(JSON.stringify({ message: 'destination exists' }), { status: 409 }) });
  await expect(client.moveModel(target, { from: 'a', to: 'b' })).rejects.toMatchObject<Partial<AgentError>>({ kind: 'busy', message: 'destination exists' });
});

it('uses the public HTTPS origin and refuses redirects when sending the agent token', async () => {
 const fetchImpl=vi.fn(async()=>Response.json({ok:true}));const client=makeAgentClient({fetchImpl});
 await client.ping({...target,agentUrl:'https://agent.example.com:8443'});
 expect(fetchImpl).toHaveBeenCalledWith('https://agent.example.com:8443/agent/ping',expect.objectContaining({redirect:'error',headers:expect.objectContaining({'X-Rippel-Agent-Token':'secret'})}));
});

it('deletes one model file and keeps the 404 an old agent gives for the route', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ deleted: 'checkpoints/a.safetensors', missing: false }));
  expect(await makeAgentClient({ fetchImpl }).deleteModel(target, 'checkpoints/a.safetensors')).toEqual({ deleted: 'checkpoints/a.safetensors', missing: false });
  expect(fetchImpl).toHaveBeenCalledWith('http://gpu:8189/agent/models/delete', expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: 'checkpoints/a.safetensors' }) }));
  const old = makeAgentClient({ fetchImpl: async () => Response.json({ message: 'No such route.' }, { status: 404 }) });
  await expect(old.deleteModel(target, 'checkpoints/a.safetensors')).rejects.toMatchObject({ kind: 'refused', status: 404 });
});
