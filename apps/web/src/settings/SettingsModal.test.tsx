import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Backend, BackendProbe, User } from '@comfy/shared';
import type { ReactNode } from 'react';
import { AuthContext, type AuthState } from '../auth/context';
import { ApiRequestError } from '../lib/api';
import type { BackendsApi } from '../lib/api-backends';
import { SettingsModal } from './SettingsModal';
import { UserMenu } from '../shell/UserMenu';

const admin: User = { id: 'u1', email: 'admin@example.com', displayName: 'Ada', role: 'admin', createdAt: '' };
const member: User = { id: 'u2', email: 'm@example.com', displayName: null, role: 'user', createdAt: '' };

const desktop: Backend = {
  id: 'b1',
  name: 'desktop-6900xt',
  baseUrl: 'http://192.168.1.10:8188',
  enabled: true,
  status: 'online',
  deviceName: 'cuda:0 AMD Radeon RX 6900 XT',
  vramFree: 8e9,
  vramTotal: 17e9,
  ramFree: null,
  ramTotal: null,
  vramLimitMb: null,
  lastSeenAt: null,
  queueDepth: 0,
};

function fakeApi(initial: Backend[] = [desktop]) {
  const backends = [...initial];
  const api: BackendsApi = {
    list: vi.fn(async () => [...backends]),
    create: vi.fn(async (input) => {
      const created: Backend = { ...desktop, id: `b${backends.length + 1}`, name: input.name, baseUrl: input.baseUrl, status: 'unknown', deviceName: null, vramTotal: null, vramFree: null, vramLimitMb: input.vramLimitMb ?? null };
      backends.push(created);
      return created;
    }),
    update: vi.fn(async (id, patch) => {
      const row = backends.find((b) => b.id === id)!;
      Object.assign(row, patch);
      return { ...row };
    }),
    remove: vi.fn(async (id) => {
      const i = backends.findIndex((b) => b.id === id);
      backends.splice(i, 1);
    }),
    probe: vi.fn(async (): Promise<BackendProbe> => ({ ok: true, latencyMs: 12, version: '0.34.0', device: 'cuda:0' })),
    probeAddress: vi.fn(async (): Promise<BackendProbe> => ({ ok: true, latencyMs: 9, version: '0.34.0' })),
  };
  return { api, backends };
}

function withAuth(user: User, children: ReactNode) {
  const value: AuthState = {
    status: 'authenticated',
    user,
    allowRegistration: false,
    signIn: async () => {},
    signUp: async () => {},
    signOut: async () => {},
  };
  return <AuthContext value={value}>{children}</AuthContext>;
}

describe('SettingsModal', () => {
  it('lists the backends with their status and address', async () => {
    const { api } = fakeApi();
    render(<SettingsModal open onClose={() => {}} api={api} version="0.1.0" />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(dialog).findByText('desktop-6900xt')).toBeInTheDocument();
    expect(within(dialog).getByText('http://192.168.1.10:8188')).toBeInTheDocument();
    expect(within(dialog).getByRole('switch', { name: /desktop-6900xt enabled/i })).toBeChecked();
  });

  it('adds a backend after testing the address', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    render(<SettingsModal open onClose={() => {}} api={api} version="0.1.0" />);
    await screen.findByText('desktop-6900xt');

    await user.click(screen.getByRole('button', { name: /add backend/i }));
    const form = screen.getByRole('form', { name: 'Add backend' });
    await user.type(within(form).getByLabelText(/^name/i), 'laptop');
    const address = within(form).getByLabelText(/comfyui address/i);
    await user.clear(address);
    await user.type(address, 'http://192.168.1.20:8188');

    await user.click(within(form).getByRole('button', { name: /test connection/i }));
    expect(await within(form).findByText(/answered in/i)).toBeInTheDocument();
    expect(api.probeAddress).toHaveBeenCalledWith('http://192.168.1.20:8188');

    await user.click(within(form).getByRole('button', { name: /^add backend$/i }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ name: 'laptop', baseUrl: 'http://192.168.1.20:8188', vramLimitMb: null }));
    expect(await screen.findByText('laptop')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add backend' })).not.toBeInTheDocument();
  });

  it('shows a validation message from the server on the form', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    vi.mocked(api.create).mockRejectedValueOnce(new ApiRequestError(409, 'conflict', 'There is already a backend called "desktop-6900xt".'));
    render(<SettingsModal open onClose={() => {}} api={api} version="0.1.0" />);
    await screen.findByText('desktop-6900xt');
    await user.click(screen.getByRole('button', { name: /add backend/i }));
    const form = screen.getByRole('form', { name: 'Add backend' });
    await user.type(within(form).getByLabelText(/^name/i), 'desktop-6900xt');
    await user.type(within(form).getByLabelText(/comfyui address/i), '192.168.1.10:8188');
    await user.click(within(form).getByRole('button', { name: /^add backend$/i }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/already a backend/i);
  });

  it('removes in two presses, and reports a busy refusal', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    render(<SettingsModal open onClose={() => {}} api={api} version="0.1.0" />);
    await screen.findByText('desktop-6900xt');

    await user.click(screen.getByRole('button', { name: 'Remove desktop-6900xt' }));
    expect(api.remove).not.toHaveBeenCalled();
    const armed = screen.getByRole('button', { name: 'Really remove desktop-6900xt' });

    vi.mocked(api.remove).mockRejectedValueOnce(new ApiRequestError(409, 'busy', 'desktop-6900xt is generating right now.'));
    await user.click(armed);
    expect(await screen.findByRole('status')).toHaveTextContent(/generating right now/i);
    expect(screen.getByText('desktop-6900xt')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove desktop-6900xt' }));
    await user.click(screen.getByRole('button', { name: 'Really remove desktop-6900xt' }));
    await waitFor(() => expect(screen.queryByText('desktop-6900xt')).not.toBeInTheDocument());
    expect(api.remove).toHaveBeenCalledTimes(2);
  });

  it('toggles enabled optimistically', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    render(<SettingsModal open onClose={() => {}} api={api} version="0.1.0" />);
    const toggle = await screen.findByRole('switch', { name: /desktop-6900xt enabled/i });
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('b1', { enabled: false }));
  });

  it('is offered to administrators only, from the account menu', async () => {
    const user = userEvent.setup();
    render(withAuth(member, <UserMenu />));
    await user.click(screen.getByRole('button', { name: /account/i }));
    expect(screen.queryByRole('menuitem', { name: /settings/i })).not.toBeInTheDocument();

    render(withAuth(admin, <UserMenu />));
    await user.click(screen.getByRole('button', { name: /account: admin@example.com/i }));
    expect(screen.getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
  });
});
