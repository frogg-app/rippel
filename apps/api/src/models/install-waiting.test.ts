import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query, queryOne } from '../db.js';
import { dispatchWaitingInstalls, startInstall } from './installs.js';

const row = {
  id: 'part-1',
  backend_id: 'b1',
  base_url: 'http://desktop:8188',
  filename: 't5xxl_fp8.safetensors',
  display_name: 't5',
  model_type: 'clip',
  base_model: 'FLUX',
  url: 'https://huggingface.co/x/resolve/main/t5xxl_fp8.safetensors',
  save_path: 'text_encoders',
  status: 'waiting',
};

beforeEach(() => vi.resetAllMocks());

describe('installs that wait their turn', () => {
  it('records a part behind the model instead of starting it', async () => {
    vi.mocked(queryOne).mockResolvedValue({ ...row, created_at: new Date() } as never);
    const transport = { kind: 'rippel-agent', install: vi.fn() };
    const install = await startInstall({
      backendId: 'b1',
      backendName: 'Desktop',
      requestedBy: 'u1',
      entry: { ...row, name: 't5', type: 'clip', base: 'FLUX', ref: 'text_encoders/t5xxl_fp8.safetensors', installed: false } as never,
      transport: transport as never,
      after: 'model-1',
    });
    expect(install.status).toBe('waiting');
    expect(transport.install).not.toHaveBeenCalled();
    const [, values] = vi.mocked(queryOne).mock.calls[0]!;
    expect(values).toContain('waiting');
    expect(values).toContain('model-1');
  });

  it('only claims a waiting install that is still waiting', async () => {
    vi.mocked(query).mockResolvedValueOnce([row] as never);
    // Somebody else got there first.
    vi.mocked(queryOne).mockResolvedValueOnce(null as never);
    await dispatchWaitingInstalls();
    const [sql] = vi.mocked(queryOne).mock.calls[0]!;
    expect(sql).toContain("status = 'queued' WHERE id = $1 AND status = 'waiting'");
  });

  it('waits for the machine to be free and the earlier install to finish', async () => {
    vi.mocked(query).mockResolvedValueOnce([] as never);
    await dispatchWaitingInstalls();
    const [sql] = vi.mocked(query).mock.calls[0]!;
    expect(sql).toContain("prev.status IN ('complete', 'failed', 'cancelled')");
    expect(sql).toContain("busy.status IN ('queued', 'downloading')");
  });
});
