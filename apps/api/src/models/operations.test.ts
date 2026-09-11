import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() }));
vi.mock('../deploy/agent-client.js', () => ({ agentClient: { moveModel: vi.fn(), downloadModel: vi.fn() } }));
vi.mock('../lib/backend-poller.js', () => ({ pollBackendNow: vi.fn() }));
import { query, queryOne } from '../db.js';
import { agentClient } from '../deploy/agent-client.js';
import { startOperation } from './operations.js';
const operation = { id: 'op', backend_id: 'backend', status: 'starting', step_index: 0,
  steps: [{ kind: 'move', request: { from: 'checkpoints/hunyuan.safetensors', to: 'diffusion_models/hunyuan.safetensors' } }] };
beforeEach(() => vi.resetAllMocks());
it('claims a planned operation before starting the agent and retains its task id', async () => {
  vi.mocked(queryOne).mockResolvedValueOnce(operation).mockResolvedValueOnce({ host: 'desktop', agent_port: 8189, token: 'secret' }).mockResolvedValueOnce({ ...operation, status: 'running' });
  vi.mocked(agentClient.moveModel).mockResolvedValue({ id: 'remote-task', kind: 'model-files', status: 'running', startedAt: '', finishedAt: null, log: [], error: null });
  await startOperation('op');
  expect(vi.mocked(queryOne).mock.calls[0]![0]).toContain("status = 'planned'");
  expect(agentClient.moveModel).toHaveBeenCalledWith({ host: 'desktop', agentPort: 8189, token: 'secret' }, operation.steps[0]!.request);
  expect(vi.mocked(query).mock.calls[0]![1]?.[1]).toBe('remote-task');
});
it('does not replay a started action or retry an ambiguous transport failure', async () => {
  vi.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce(operation);
  await startOperation('op');
  expect(agentClient.moveModel).not.toHaveBeenCalled();
  vi.mocked(queryOne).mockResolvedValueOnce(operation).mockResolvedValueOnce({ host: 'desktop', agent_port: 8189, token: 'secret' }).mockResolvedValueOnce(operation);
  vi.mocked(agentClient.moveModel).mockRejectedValue(new Error('Connection lost'));
  await startOperation('op');
  expect(agentClient.moveModel).toHaveBeenCalledTimes(1);
  expect(vi.mocked(query).mock.calls[0]![1]?.[1]).toContain('Re-check the backend');
});
