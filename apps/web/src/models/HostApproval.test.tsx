import { beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HostApproval } from './HostApproval';
import { InstallProgress } from './InstallProgress';
import { makeInstall } from './testing';
import type { ModelsApi } from '../lib/api-models';
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
const install = makeInstall({ status: 'downloading', approvalRequired: { hostname: 'cdn.example.com' } });
it.each([['Approve host', true], ['Deny', false]] as const)('sends only the explicit %s choice', async (label, approve) => {
  const approveHost = vi.fn().mockResolvedValue(undefined);
  render(<HostApproval installs={[install]} api={{ approveHost } as unknown as ModelsApi} />);
  expect(approveHost).not.toHaveBeenCalled();
  expect(screen.getByText('cdn.example.com')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() => expect(approveHost).toHaveBeenCalledWith(install.backendId, install.id, 'cdn.example.com', approve));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('Later leaves it paused and allows review again', () => {
  const approveHost = vi.fn();
  render(<HostApproval installs={[install]} api={{ approveHost } as unknown as ModelsApi} />);
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Review host/ }));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(approveHost).not.toHaveBeenCalled();
});
it('does not animate download progress while approval is pending', () => {
  render(<InstallProgress install={install} now={Date.now()} />);
  expect(screen.getByRole('status')).toHaveTextContent('Approval needed');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});
