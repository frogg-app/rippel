import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Backend, User } from '@comfy/shared';
import { AuthContext, type AuthState } from '../auth/context';
import { GpuSetupLine, gpuBlocked } from './GpuSetupLine';
import { friendlyFailure } from './failureText';

function backend(over: Partial<Backend>): Backend {
  return {
    id: 'b1', name: 'steve-pc', baseUrl: '', enabled: true, status: 'online', deviceName: null,
    vramFree: null, vramTotal: null, ramFree: null, ramTotal: null, vramLimitMb: null,
    lastSeenAt: null, queueDepth: 0, ...over,
  };
}

function withRole(role: 'admin' | 'user', ui: React.ReactNode) {
  const auth = { status: 'authenticated', user: { id: 'u', role } as User } as AuthState;
  return <AuthContext.Provider value={auth}>{ui}</AuthContext.Provider>;
}

describe('gpuBlocked', () => {
  it('blocks the chosen machine when its GPU test failed', () => {
    const list = [backend({ gpuState: 'unsupported' }), backend({ id: 'b2', gpuState: 'ready' })];
    expect(gpuBlocked(list, 'b1')?.id).toBe('b1');
    expect(gpuBlocked(list, 'b2')).toBeNull();
    // Routed automatically, another machine can take it.
    expect(gpuBlocked(list, null)).toBeNull();
    expect(gpuBlocked([backend({ gpuState: 'unsupported' })], null)?.id).toBe('b1');
    // Older agents report nothing; never block on a guess.
    expect(gpuBlocked([backend({})], null)).toBeNull();
  });
});

describe('GpuSetupLine', () => {
  it('gives admins Repair', async () => {
    const repairGpu = vi.fn(async () => ({}));
    render(withRole('admin', <GpuSetupLine deploymentId="d1" repairGpu={repairGpu} />));
    expect(screen.getByText(/graphics card isn’t set up correctly/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Repair' }));
    await waitFor(() => expect(repairGpu).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText('Repairing…')).toBeInTheDocument();
  });

  it('tells everyone else to ask an admin', () => {
    render(withRole('user', <GpuSetupLine deploymentId={null} />));
    expect(screen.getByText('Ask an admin to repair this PC.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('friendlyFailure', () => {
  it('reads hipErrorInvalidImage as GPU setup and keeps the raw text', () => {
    const raw = "VAEEncode failed: CUDA error: device kernel image is invalid\nSearch for `hipErrorInvalidImage'";
    expect(friendlyFailure(raw)).toMatchObject({ kind: 'gpu-setup', detail: raw });
    expect(friendlyFailure('no kernel image is available for execution on the device')?.kind).toBe('gpu-setup');
  });
});
