import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() }));
vi.mock('../deploy/agent-client.js', async () => ({ ...await vi.importActual('../deploy/agent-client.js'), agentClient: { moveModel: vi.fn(), downloadModel: vi.fn(), task: vi.fn() } }));
vi.mock('../lib/backend-poller.js', () => ({ pollBackendNow: vi.fn() }));
import { query, queryOne } from '../db.js';
import { AgentError, agentClient } from '../deploy/agent-client.js';
import { pollOperation, startOperation, startModelOperationPoller } from './operations.js';
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

it('fails a lost agent task without replaying it and protects newer steps', async () => {
  vi.mocked(queryOne).mockResolvedValue({ host: 'desktop', agent_port: 8189, token: 'secret' });
  vi.mocked(agentClient.task).mockRejectedValue(new AgentError('refused', 'No such task', 404));
  await pollOperation({ ...operation, status: 'running', agent_task_id: 'lost-task' } as never);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("status='failed'"), ['op', 'lost-task']);
  expect(vi.mocked(query).mock.calls[0]![0]).toContain("status='running' AND agent_task_id=$2");
  expect(agentClient.moveModel).not.toHaveBeenCalled();
  expect(agentClient.downloadModel).not.toHaveBeenCalled();
});
it('leaves transient agent outages in progress for the next poll', async () => {
  vi.mocked(queryOne).mockResolvedValue({ host: 'desktop', agent_port: 8189, token: 'secret' });
  vi.mocked(agentClient.task).mockRejectedValue(new AgentError('unreachable', 'Timed out'));
  await expect(pollOperation({ ...operation, status: 'running', agent_task_id: 'task' } as never)).rejects.toThrow('Timed out');
  expect(query).not.toHaveBeenCalled();
});
it('does not contact a removed backend', async () => {
  await pollOperation({ ...operation, backend_id: null, status: 'running', agent_task_id: 'task' } as never);
  expect(agentClient.task).not.toHaveBeenCalled();
});

it('keeps a download queued when the backend cannot be claimed', async () => {
  vi.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...operation, status: 'planned' });
  expect(await startOperation('op', true)).toMatchObject({ status: 'planned' });
  expect(agentClient.downloadModel).not.toHaveBeenCalled();
  expect(agentClient.moveModel).not.toHaveBeenCalled();
});
it('leaves a concurrent claim loser queued without dispatching twice', async () => {
  vi.mocked(queryOne).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: '23505', constraint: 'model_operation_active_backend' }))
    .mockResolvedValueOnce({ ...operation, status: 'planned' });
  expect(await startOperation('op', true)).toMatchObject({ status: 'planned' });
  expect(agentClient.downloadModel).not.toHaveBeenCalled();
  expect(agentClient.moveModel).not.toHaveBeenCalled();
});
it('returns a definite agent busy refusal to the queue', async () => {
  const download = { ...operation, steps: [{ kind: 'download', request: { url: 'https://huggingface.co/model', path: 'checkpoints/model.safetensors', sha256: 'a'.repeat(64) } }] };
  vi.mocked(queryOne).mockResolvedValueOnce(download).mockResolvedValueOnce({ host: 'desktop', agent_port: 8189, token: 'secret' }).mockResolvedValueOnce({ ...download, status: 'planned' });
  vi.mocked(agentClient.downloadModel).mockRejectedValue(new AgentError('busy', 'Another task is running', 409));
  expect(await startOperation('op', true)).toMatchObject({ status: 'planned' });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("status='planned'"), ['op']);
});

afterEach(() => vi.useRealTimers());
it('drains persisted queued installs on the poller without an open browser', async () => {
  vi.useFakeTimers();
  vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...operation, status: 'planned' }]);
  vi.mocked(queryOne).mockResolvedValueOnce(operation).mockResolvedValueOnce({ host: 'desktop', agent_port: 8189, token: 'secret' }).mockResolvedValueOnce({ ...operation, status: 'running' });
  vi.mocked(agentClient.moveModel).mockResolvedValue({ id: 'task', status: 'running' } as never);
  const stop = startModelOperationPoller(vi.fn());
  try {
    await vi.advanceTimersByTimeAsync(2000);
    expect(agentClient.moveModel).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("i.status IN ('queued','downloading')"));
  } finally { stop(); }
});
