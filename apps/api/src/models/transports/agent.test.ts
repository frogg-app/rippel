import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../../db.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../deploy/agent-client.js', () => ({ agentClient: { ping: vi.fn() } }));
vi.mock('../operations.js', () => ({ getOperation: vi.fn(), planOperation: vi.fn(), startOperation: vi.fn() }));
vi.mock('../download-metadata.js', () => ({ verifiedFile: vi.fn() }));
import { query, queryOne } from '../../db.js';
import { agentClient } from '../../deploy/agent-client.js';
import { getOperation, planOperation, startOperation } from '../operations.js';
import { verifiedFile } from '../download-metadata.js';
import { AgentModelTransport, agentModelPath, AGENT_CATALOGUE_URL } from './agent.js';
const target = { host: 'desktop', agentPort: 8189, token: 'test-token' };
const request = { installId: 'install', name: 'Model', filename: 'model.safetensors', savePath: 'unet', folder: 'diffusion_models', url: 'https://huggingface.co/org/repo/resolve/main/model.safetensors', type: 'checkpoint', base: 'SDXL' };
const transport = () => new AgentModelTransport('backend', target, 'http://desktop:8188');
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllGlobals());
it('accepts safe native model folders and normalizes legacy aliases', () => {
  expect(agentModelPath({ ...request, type: 'checkpoint' })).toBe('diffusion_models/model.safetensors');
  for (const savePath of ['../custom_nodes', '/checkpoints', 'checkpoints/../../custom_nodes', 'C:\\models', 'custom_nodes']) {
    expect(agentModelPath({ ...request, type: 'checkpoint', savePath })).toBeNull();
  }
  expect(agentModelPath({ ...request, type: 'checkpoint', filename: 'script.py' })).toBeNull();
});
it('requires an agent version with native model downloads', async () => {
  vi.mocked(agentClient.ping).mockResolvedValue({ ok: true, version: '0.3.0', platform: 'win32', hostname: 'desktop' });
  expect(await transport().available()).toBe(true);
  vi.mocked(agentClient.ping).mockResolvedValue({ ok: true, version: '0.2.0', platform: 'win32', hostname: 'desktop' });
  expect(await transport().available()).toBe(false);
});
it('loads catalogue without Manager and checks installed files on the engine', async () => {
  const fetchMock = vi.fn(async (url: string) => url === AGENT_CATALOGUE_URL
    ? Response.json({ models: [
        { ...request, save_path: 'unet' },
        { ...request, save_path: 'checkpoints', url: 'https://untrusted.example/model.safetensors' },
        { ...request, save_path: '../custom_nodes' },
      ] })
    : Response.json(['model.safetensors']));
  vi.stubGlobal('fetch', fetchMock);
  const entries = await transport().catalogue();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ installed: true, ref: 'diffusion_models/model.safetensors' });
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual([AGENT_CATALOGUE_URL, 'http://desktop:8188/api/models/diffusion_models']);
});
it('journals the operation link before dispatching a checksum-verified download', async () => {
  vi.mocked(verifiedFile).mockResolvedValue({ name: request.filename, directory: 'diffusion_models', paths: [], url: request.url, sha256: 'a'.repeat(64), sizeBytes: 123 });
  vi.mocked(queryOne).mockResolvedValue({ requested_by: 'admin' });
  vi.mocked(planOperation).mockResolvedValue({ id: 'operation' } as never);
  vi.mocked(startOperation).mockResolvedValue({ id: 'operation', status: 'running' } as never);
  await transport().install(request);
  expect(planOperation).toHaveBeenCalledWith({ backendId: 'backend', actorId: 'admin', steps: [{ kind: 'download', request: { url: request.url, path: 'diffusion_models/model.safetensors', sha256: 'a'.repeat(64), sizeBytes: 123 } }] });
  expect(query).toHaveBeenCalledWith(expect.stringContaining('operation_id = $2'), ['install', 'operation', 123]);
  expect(vi.mocked(query).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(startOperation).mock.invocationCallOrder[0]!);
});
it('refuses missing publisher verification before any download is sent', async () => {
  vi.mocked(verifiedFile).mockRejectedValue(new Error('No checksum available'));
  await expect(transport().install(request)).rejects.toThrow('No checksum available');
  expect(planOperation).not.toHaveBeenCalled();
  expect(startOperation).not.toHaveBeenCalled();
});
it('tracks durable operation progress across transport recreation', async () => {
  vi.mocked(queryOne).mockResolvedValue({ operation_id: 'operation' });
  vi.mocked(getOperation).mockResolvedValue({ status: 'running', progress: { bytesReceived: 123 }, error: null } as never);
  expect(await transport().progress(request)).toMatchObject({ state: 'downloading', bytesReceived: 123 });
  vi.mocked(getOperation).mockResolvedValue({ status: 'done', progress: { bytesReceived: 123 }, error: null } as never);
  expect(await transport().progress(request)).toMatchObject({ state: 'complete' });
});
it('fails interrupted setup without replaying a download', async () => {
  vi.mocked(queryOne).mockResolvedValue({ operation_id: null, created_at: new Date(Date.now() - 130_000) });
  expect(await transport().progress(request)).toMatchObject({ state: 'failed' });
  expect(startOperation).not.toHaveBeenCalled();
});
it('keeps host approval paused across transport recreation and clears it on failure', async () => {
  vi.mocked(queryOne).mockResolvedValue({ operation_id: 'operation' });
  vi.mocked(getOperation).mockResolvedValue({ status: 'running', progress: { status: 'running', approvalRequired: { hostname: 'cdn.example.com' } }, error: null } as never);
  expect(await transport().progress(request)).toMatchObject({ state: 'downloading', detail: 'Approval needed', approvalRequired: { hostname: 'cdn.example.com' } });
  vi.mocked(getOperation).mockResolvedValue({ status: 'failed', progress: { status: 'failed' }, error: 'Download host approval declined.' } as never);
  expect(await transport().progress(request)).toMatchObject({ state: 'failed', approvalRequired: null, error: 'Download host approval declined.' });
});
