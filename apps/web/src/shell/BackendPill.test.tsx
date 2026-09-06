import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Backend } from '@comfy/shared';
import { BackendPill } from './BackendPill';

const GB = 1024 * 1024 * 1024;

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    id: 'b1',
    name: 'desktop-4090',
    baseUrl: '',
    enabled: true,
    status: 'online',
    deviceName: 'cuda:0',
    vramFree: 18.3 * GB,
    vramTotal: 36.5 * GB,
    ramFree: null,
    ramTotal: null,
    vramLimitMb: null,
    lastSeenAt: null,
    queueDepth: 0,
    ...overrides,
  };
}

describe('BackendPill', () => {
  it('shows used/total memory and never calls it the size of the card', () => {
    render(<BackendPill backend={backend()} loading={false} unreachable={false} extraCount={0} />);

    expect(screen.getByText('desktop-4090')).toBeInTheDocument();
    expect(screen.getByText(/18\.2\/36\.5 GB/)).toBeInTheDocument();
    // The figure is a budget the backend reports, not installed VRAM — the
    // qualifier is the whole reason this component is not a one-liner.
    expect(screen.getByText(/reported/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/VRAM/i);
  });

  it('prefers an operator-set budget over the reported figure', () => {
    render(
      <BackendPill
        backend={backend({ vramLimitMb: 16384, vramFree: 4 * GB })}
        loading={false}
        unreachable={false}
        extraCount={0}
      />,
    );

    expect(screen.getByText(/12\.0\/16\.0 GB/)).toBeInTheDocument();
    expect(screen.getByText(/budget/)).toBeInTheDocument();
  });

  it('says offline rather than showing stale memory when the backend is down', () => {
    render(
      <BackendPill
        backend={backend({ status: 'offline' })}
        loading={false}
        unreachable={false}
        extraCount={0}
      />,
    );

    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.queryByText(/GB/)).not.toBeInTheDocument();
  });

  it('distinguishes an unreachable API from an offline backend', () => {
    render(<BackendPill backend={null} loading={false} unreachable extraCount={0} />);
    expect(screen.getByText('Server unreachable')).toBeInTheDocument();
  });
});
