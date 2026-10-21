import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '@comfy/shared';
import type { ReactNode } from 'react';
import { AuthContext, type AuthState } from '../auth/context';
import { deploymentsApi } from '../lib/api-deployments';

vi.mock('../lib/api-deployments', () => ({ deploymentsApi: { list: vi.fn(async () => []) } }));
import { SettingsModal } from './SettingsModal';
import { UserMenu } from '../shell/UserMenu';

const admin: User = { id: 'u1', email: 'admin@example.com', displayName: 'Ada', role: 'admin', createdAt: '' };
const member: User = { id: 'u2', email: 'm@example.com', displayName: null, role: 'user', createdAt: '' };

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
  it('opens agent-managed Backends without a separate deployment or direct server path', async () => {
    render(<SettingsModal open onClose={() => {}} version="0.1.0" />);
    await screen.findByText(/No backends yet/);
    expect(deploymentsApi.list).toHaveBeenCalled();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['Backends', 'About']);
    expect(screen.queryByRole('button', { name: /^Add backend$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install by hand/i })).toBeInTheDocument();
  });

  it('retains About and closes with Escape', async () => {
    const close = vi.fn();
    const user = userEvent.setup();
    render(<SettingsModal open onClose={close} version="0.1.0" />);
    await user.click(screen.getByRole('button', { name: 'About' }));
    expect(screen.getByText('version 0.1.0')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(close).toHaveBeenCalledOnce();
  });

  it('offers administrators a dedicated settings button outside the account menu', async () => {
    const user = userEvent.setup();
    render(withAuth(member, <UserMenu />));
    await user.click(screen.getByRole('button', { name: /account/i }));
    expect(screen.queryByRole('menuitem', { name: /settings/i })).not.toBeInTheDocument();

    render(withAuth(admin, <UserMenu />));
    await user.click(screen.getByRole('button', { name: /account: admin@example.com/i }));
    expect(screen.queryByRole('menuitem', { name: /settings/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });
});

it('shows user management only to administrators and grants delegated settings access', async () => {
  const view=render(withAuth({...member,settingsAccess:true},<UserMenu/>));
  await userEvent.click(screen.getByRole('button',{name:'Settings'}));
  await screen.findByText(/No backends yet/);
  expect(screen.queryByRole('button',{name:'Users'})).not.toBeInTheDocument();
  view.unmount();
  render(<SettingsModal open currentUser={admin} onClose={()=>{}}/>);
  await screen.findByText(/No backends yet/);
  expect(screen.getByRole('button',{name:'Users'})).toBeInTheDocument();
});
