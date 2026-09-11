import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../lib/api', () => ({ request: vi.fn() }));
import { request } from '../lib/api';
import { FixModel } from './FixModel';
const operation = { id: 'op', status: 'planned', step_index: 0, progress: null, error: null,
  steps: [{ kind: 'move', request: { from: 'checkpoints/model', to: 'diffusion_models/model' } }] };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('shows exact paths and waits for confirmation before starting a fix', async () => {
  vi.mocked(request).mockResolvedValueOnce({ operation: null }).mockResolvedValueOnce({ operation, unavailable: [] })
    .mockResolvedValueOnce({ operation: { ...operation, status: 'running' } });
  render(<FixModel modelId="model" backendId="backend" />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
  await screen.findByText(/checkpoints\/model → diffusion_models\/model/);
  expect(request).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm file changes' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/model-operations/op/start', { method: 'POST' }));
});
it('restores running progress from the server after a page refresh', async () => {
  vi.mocked(request).mockResolvedValueOnce({ operation: { ...operation, status: 'running' } });
  render(<FixModel modelId="model" backendId="backend" />);
  expect(await screen.findByText(/Step 1 of 1: Moving/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Fix' })).toBeNull();
});
