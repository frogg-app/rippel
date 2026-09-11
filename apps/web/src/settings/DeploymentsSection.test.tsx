import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentTask, ComfyState, Deployment } from '@comfy/shared';
import { ApiRequestError } from '../lib/api';
import type { DeploymentsApi, InstallInstructions } from '../lib/api-deployments';
import { DeploymentsSection } from './DeploymentsSection';

/**
 * The deployment panel from the operator's side: what a machine's card says
 * about it, which buttons that state offers, and that the manual path ends in
 * a command with the token already in it.
 */

const COMFY: ComfyState = {
  installed: true,
  running: true,
  path: '/home/steve/.rippel-agent/ComfyUI',
  version: '0.34.0',
  commit: 'abc1234',
  port: 8188,
  helperInstalled: true,
  helperReady: true,
  diskFree: 400e9,
  diskTotal: 2000e9,
};

const online: Deployment = {
  id: 'd1',
  name: 'studio-4090',
  host: '192.168.1.50',
  agentPort: 8189,
  platform: 'linux',
  status: 'online',
  agentVersion: '0.1.0',
  comfy: COMFY,
  backendId: null,
  backendName: null,
  lastSeenAt: new Date().toISOString(),
  createdAt: '2026-09-01T00:00:00Z',
  token: 'tok-secret',
};

const instructions: InstallInstructions = {
  serverUrl: 'http://192.168.1.9:4000',
  token: 'tok-secret',
  // Four builds, not three: macOS is split by architecture, which is the whole
  // reason picking a download by platform alone is wrong.
  downloads: [
    {
      target: 'windows-amd64',
      platform: 'win32',
      arch: 'amd64',
      label: 'Windows',
      sizeBytes: 7599104,
      url: 'http://192.168.1.9:4000/api/deployments/d1/agent/windows-amd64?token=tok-secret',
      fileName: 'rippel-agent-setup-blob.exe',
    },
    {
      target: 'macos-arm64',
      platform: 'darwin',
      arch: 'arm64',
      label: 'macOS (Apple silicon)',
      sizeBytes: 6964018,
      url: 'http://192.168.1.9:4000/api/deployments/d1/agent/macos-arm64?token=tok-secret',
      fileName: 'rippel-agent-setup-blob',
    },
    {
      target: 'macos-amd64',
      platform: 'darwin',
      arch: 'amd64',
      label: 'macOS (Intel)',
      sizeBytes: 7528896,
      url: 'http://192.168.1.9:4000/api/deployments/d1/agent/macos-amd64?token=tok-secret',
      fileName: 'rippel-agent-setup-blob',
    },
    {
      target: 'linux-amd64',
      platform: 'linux',
      arch: 'amd64',
      label: 'Linux',
      sizeBytes: 7372960,
      url: 'http://192.168.1.9:4000/api/deployments/d1/agent/linux-amd64?token=tok-secret',
      fileName: 'rippel-agent-setup-blob',
    },
  ],
  commands: {
    linux: "curl -fsSL 'http://192.168.1.9:4000/api/deployments/d1/install.sh?token=tok-secret' | bash",
    darwin: "curl -fsSL 'http://192.168.1.9:4000/api/deployments/d1/install.sh?token=tok-secret' | bash",
    win32: `powershell -ExecutionPolicy Bypass -Command "irm 'http://192.168.1.9:4000/api/deployments/d1/install.ps1?token=tok-secret' | iex"`,
  },
  release: {
    tag: 'agent-v0.1.0',
    name: 'agent 0.1.0',
    publishedAt: '2026-09-01T00:00:00Z',
    url: 'https://github.com/frogg-app/rippel/releases/tag/agent-v0.1.0',
    downloads: [
      { platform: 'win32', label: 'Windows', url: 'https://example.test/win.zip', sizeBytes: 40960 },
      { platform: 'darwin', label: 'macOS', url: 'https://example.test/mac.tar.gz', sizeBytes: 40960 },
      { platform: 'linux', label: 'Linux', url: 'https://example.test/linux.tar.gz', sizeBytes: 40960 },
    ],
    note: null,
  },
};

function done(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 't1',
    kind: 'install-comfyui',
    status: 'done',
    startedAt: '',
    finishedAt: '',
    log: ['$ git clone …', 'ComfyUI installed.'],
    error: null,
    ...over,
  };
}

function fakeApi(initial: Deployment[] = [online], over: Partial<DeploymentsApi> = {}) {
  const rows = [...initial];
  const api: DeploymentsApi = {
    list: vi.fn(async () => [...rows]),
    create: vi.fn(async (input) => {
      const made: Deployment = {
        ...online,
        id: 'd-new',
        name: input.name,
        host: input.host,
        status: 'pending',
        comfy: null,
        agentVersion: null,
        lastSeenAt: null,
      };
      rows.push(made);
      return made;
    }),
    remove: vi.fn(async () => {}),
    probe: vi.fn(async () => ({ ok: true, latencyMs: 11, version: '0.1.0', hostname: 'studio' })),
    status: vi.fn(async () => ({ comfy: COMFY, accelerator: 'cuda' as const, tasks: [] })),
    instructions: vi.fn(async () => instructions),
    pairingCode: vi.fn(async () => ({
      code: 'K7M4P2QR',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    })),
    releases: vi.fn(async () => instructions.release),
    installComfy: vi.fn(async () => done()),
    updateComfy: vi.fn(async () => done({ kind: 'update-comfyui' })),
    power: vi.fn(async () => ({ started: true })),
    installHelper: vi.fn(async () => done({ kind: 'install-helper' })),
    task: vi.fn(async () => ({ task: done(), logOffset: 2 })),
    registerBackend: vi.fn(async () => ({
      deployment: { ...online, backendId: 'b1', backendName: 'studio-4090' },
      adopted: false,
    })),
    sshInstall: vi.fn(),
    run: vi.fn(),
    ...over,
  };
  return { api, rows };
}

describe('DeploymentsSection', () => {
  it('shows a machine, its ComfyUI and its helper', async () => {
    const { api } = fakeApi();
    render(<DeploymentsSection api={api} />);

    expect(await screen.findByText('studio-4090')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.50:8189')).toBeInTheDocument();
    expect(screen.getByText('Linux')).toBeInTheDocument();
    expect(screen.getByText('agent 0.1.0')).toBeInTheDocument();
    expect(screen.getByText(/running/)).toBeInTheDocument();
    expect(screen.getByText('answering')).toBeInTheDocument();
    expect(screen.getByText('not registered')).toBeInTheDocument();
  });

  it('offers Install ComfyUI when there is none, and the run controls when there is', async () => {
    const bare = { ...online, comfy: { ...COMFY, installed: false, running: false, helperInstalled: false, helperReady: false } };
    const { api } = fakeApi([bare]);
    const { unmount } = render(<DeploymentsSection api={api} />);
    expect(await screen.findByRole('button', { name: 'Install ComfyUI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restart ComfyUI/ })).not.toBeInTheDocument();
    unmount();

    render(<DeploymentsSection api={fakeApi().api} />);
    expect(await screen.findByRole('button', { name: 'Restart ComfyUI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    // A helper that is already answering needs no button offering to install it.
    expect(screen.queryByRole('button', { name: /storage helper/ })).not.toBeInTheDocument();
  });

  it('offers the helper when it is missing, and follows the install to its log', async () => {
    const noHelper = { ...online, comfy: { ...COMFY, helperInstalled: false, helperReady: false } };
    const { api } = fakeApi([noHelper]);
    render(<DeploymentsSection api={api} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Install storage helper' }));
    await waitFor(() => expect(api.installHelper).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText(/ComfyUI installed\./)).toBeInTheDocument();
  });

  it('registers the ComfyUI as a backend', async () => {
    const { api } = fakeApi();
    render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add as backend' }));
    await waitFor(() => expect(api.registerBackend).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText('studio-4090', { selector: 'dd' })).toBeInTheDocument();
  });

  it('asks twice before removing a machine', async () => {
    const { api } = fakeApi();
    render(<DeploymentsSection api={api} />);
    const remove = await screen.findByRole('button', { name: 'Remove studio-4090' });
    await userEvent.click(remove);
    expect(api.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Really remove studio-4090' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('d1'));
  });

  it('reports a failed action without losing the card', async () => {
    const { api } = fakeApi([online], {
      status: vi.fn(async () => {
        throw new Error('studio-4090 did not answer within 15s.');
      }),
    });
    render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('studio-4090 did not answer within 15s.')).toBeInTheDocument();
    expect(screen.getByText('studio-4090')).toBeInTheDocument();
  });

  it('gives the manual path a command carrying the token', async () => {
    const { api } = fakeApi([]);
    render(<DeploymentsSection api={api} />);

    await userEvent.click(await screen.findByRole('button', { name: /Install by hand/ }));
    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'garage-box');
    await userEvent.type(screen.getByPlaceholderText('192.168.1.50'), '10.0.0.7');
    await userEvent.click(screen.getByRole('button', { name: /Register and show the command/ }));

    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ name: 'garage-box', host: '10.0.0.7' }));
    const command = await screen.findByText(/curl -fsSL/);
    expect(command).toHaveTextContent('token=tok-secret');

    // The Windows tab shows the PowerShell form of the same thing.
    await userEvent.click(screen.getByRole('tab', { name: 'Windows' }));
    expect(await screen.findByText(/powershell -ExecutionPolicy Bypass/)).toBeInTheDocument();

    // The download offered first comes from this rippel, not from GitHub: its
    // filename carries the setup code, which is what makes it a one-click
    // install rather than a file you then have to configure.
    const primary = screen.getByRole('link', { name: /Download for/ });
    expect(primary).toHaveAttribute(
      'href',
      expect.stringContaining('/api/deployments/d1/agent/'),
    );
    expect(primary).toHaveAttribute('download', expect.stringContaining('rippel-agent-setup-'));

    // Every other build stays one click away, including both Macs.
    for (const label of ['Windows', 'macOS (Apple silicon)', 'macOS (Intel)', 'Linux']) {
      expect(screen.getByRole('link', { name: new RegExp(label.replace(/[()]/g, '\\$&')) })).toBeInTheDocument();
    }
  });

  /**
   * The whole primary surface, asserted as one thing: a download, and the two
   * values a person reads to the agent. Everything else on this panel is an
   * alternative to it and belongs behind a fold.
   */
  it('leads with the download, the server URL and a one-time code', async () => {
    const { api } = fakeApi([]);
    render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /Install by hand/ }));
    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'garage-box');
    await userEvent.type(screen.getByPlaceholderText('192.168.1.50'), '10.0.0.7');
    await userEvent.click(screen.getByRole('button', { name: /Register and show the command/ }));

    // One block, named for the machine — not a menu of three mechanisms.
    expect(await screen.findByRole('heading', { level: 4 })).toHaveTextContent('Set up garage-box');
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(1);

    // The two copyable fields, each with its own copy button.
    expect(await screen.findByText('K7M4P2QR')).toBeInTheDocument();
    expect(screen.getByText('http://192.168.1.9:4000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Pairing code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Server URL' })).toBeInTheDocument();

    // The setup-link mechanism is gone, not merely demoted.
    expect(screen.queryByText(/Send a setup link/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open the setup page/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/only as reachable as the address inside it/)).not.toBeInTheDocument();

    // And so is the token the code replaces.
    expect(screen.queryByText(/Configure it by hand instead/)).not.toBeInTheDocument();
    expect(screen.queryByText('tok-secret')).not.toBeInTheDocument();

    // The command line is still there, but folded away as the alternative.
    const details = screen.getByText('Install from a command line instead').closest('details');
    expect(details).not.toHaveAttribute('open');

    // And nothing claims the agent is a folder of scripts needing a runtime.
    // These are the exact sentences the old panel shipped; the agent is one
    // static binary now, so every one of them would be a lie.
    expect(screen.queryByText(/Node\.js runtime/)).not.toBeInTheDocument();
    expect(screen.queryByText(/folder of JavaScript files/)).not.toBeInTheDocument();
    expect(screen.queryByText(/node\/bin\/node/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unpack it/)).not.toBeInTheDocument();
    expect(screen.queryByText(/tens of megabytes/)).not.toBeInTheDocument();
  });

  /**
   * A greyed-out button that says nothing is the complaint that started this.
   * It has to be reachable by keyboard and touch, so it stays focusable and
   * carries its reason as real text rather than a `title`.
   */
  it('explains why Install ComfyUI cannot be pressed yet', async () => {
    const waiting: Deployment = {
      ...online,
      id: 'd1',
      name: 'steve-pc',
      status: 'pending',
      platform: 'unknown',
      comfy: null,
      agentVersion: null,
      lastSeenAt: null,
    };
    const { api } = fakeApi([waiting]);
    render(<DeploymentsSection api={api} />);

    const install = await screen.findByRole('button', { name: 'Install ComfyUI' });
    expect(install).toHaveAttribute('aria-disabled', 'true');

    // The explanation is associated with the button, not hidden in a title.
    const tip = document.getElementById(install.getAttribute('aria-describedby')!);
    expect(tip).toHaveTextContent(/Waiting for the agent to check in/);

    // The card says the same thing in its own words, with the next move in it.
    expect(screen.getByText(/Nothing has been heard from this machine yet/)).toBeInTheDocument();
  });

  /**
   * The install command still carries a token in its URL, so the one warning
   * worth keeping is the one about sending that in the clear to a public host.
   * The paragraph explaining which address it is went with the rest of the
   * development notes — the Server URL field says it, once.
   */
  it('warns about plaintext to a public host, and only then', async () => {
    const { api } = fakeApi([]);
    const { unmount } = render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /Install by hand/ }));
    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'garage-box');
    await userEvent.type(screen.getByPlaceholderText('192.168.1.50'), '10.0.0.7');
    await userEvent.click(screen.getByRole('button', { name: /Register and show the command/ }));

    expect(await screen.findByText('http://192.168.1.9:4000')).toBeInTheDocument();
    // A LAN address in plaintext is how everyone runs this; no warning.
    expect(screen.queryByText(/carries the agent token in its URL/)).not.toBeInTheDocument();
    unmount();

    const publicUrl = 'http://dev.rippel.app';
    const { api: api2 } = fakeApi([], {
      instructions: vi.fn(async () => ({
        ...instructions,
        serverUrl: publicUrl,
        commands: {
          linux: `curl -fsSL '${publicUrl}/api/deployments/d1/install.sh?token=tok-secret' | bash`,
          darwin: `curl -fsSL '${publicUrl}/api/deployments/d1/install.sh?token=tok-secret' | bash`,
          win32: `powershell -Command "irm '${publicUrl}/api/deployments/d1/install.ps1?token=tok-secret' | iex"`,
        },
      })),
    });
    render(<DeploymentsSection api={api2} />);
    await userEvent.click(await screen.findByRole('button', { name: /Install by hand/ }));
    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'garage-box');
    await userEvent.type(screen.getByPlaceholderText('192.168.1.50'), '10.0.0.7');
    await userEvent.click(screen.getByRole('button', { name: /Register and show the command/ }));

    expect(await screen.findByText(/carries the agent token in its URL/)).toBeInTheDocument();
  });

  it('runs a managed install and streams the log', async () => {
    const run = {
      id: 'r1',
      deploymentId: 'd-new',
      host: '10.0.0.7',
      status: 'running' as const,
      startedAt: '',
      finishedAt: null,
      log: ['connecting to steve@10.0.0.7:22'],
      error: null,
    };
    const { api } = fakeApi([], {
      sshInstall: vi.fn(async () => ({ run, deployment: { ...online, id: 'd-new', name: 'garage-box' } })),
      run: vi.fn(async () => ({
        run: { ...run, status: 'done' as const, log: ['rippel: done.'] },
        logOffset: 2,
      })),
    });
    render(<DeploymentsSection api={api} />);

    await userEvent.click(await screen.findByRole('button', { name: /Deploy over SSH/ }));
    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'garage-box');
    await userEvent.type(screen.getByPlaceholderText('192.168.1.50'), '10.0.0.7');
    await userEvent.type(screen.getByPlaceholderText('steve'), 'steve');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Install the agent' }));

    await waitFor(() =>
      expect(api.sshInstall).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'garage-box', host: '10.0.0.7', username: 'steve', password: 'hunter2' }),
      ),
    );
    expect(await screen.findByText(/connecting to steve@10\.0\.0\.7/)).toBeInTheDocument();
    // The run is polled on a two-second beat, so this waits past one of them.
    expect(await screen.findByText(/rippel: done\./, undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it('sends the operating system chosen in the picker', async () => {
    // The platform control is the app's own listbox now, not a native select.
    // What must survive the swap is the value that reaches the API.
    const run = {
      id: 'r1',
      deploymentId: 'd-new',
      host: '10.0.0.7',
      status: 'done' as const,
      startedAt: '',
      finishedAt: null,
      log: ['rippel: done.'],
      error: null,
    };
    const { api } = fakeApi([], {
      sshInstall: vi.fn(async () => ({ run, deployment: { ...online, id: 'd-new', name: 'mac-mini' } })),
      run: vi.fn(async () => ({ run, logOffset: 1 })),
    });
    render(<DeploymentsSection api={api} />);

    await userEvent.click(await screen.findByRole('button', { name: /Deploy over SSH/ }));

    const platform = screen.getByRole('combobox', { name: 'Operating system' });
    expect(platform).toHaveTextContent('Linux');
    await userEvent.click(platform);
    await userEvent.click(screen.getByRole('option', { name: 'macOS' }));
    expect(platform).toHaveTextContent('macOS');

    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'mac-mini');
    await userEvent.type(screen.getByPlaceholderText('192.168.1.50'), '10.0.0.7');
    await userEvent.type(screen.getByPlaceholderText('steve'), 'steve');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Install the agent' }));

    await waitFor(() =>
      expect(api.sshInstall).toHaveBeenCalledWith(expect.objectContaining({ platform: 'darwin' })),
    );
  });

  /**
   * A code that is single-use and short-lived has to look like one on screen.
   * These four cases are the states it can be in, and each of them offers the
   * one move that gets out of it.
   */
  describe('the pairing code', () => {
    const waiting: Deployment = {
      ...online,
      name: 'steve-pc',
      status: 'pending',
      platform: 'unknown',
      comfy: null,
      agentVersion: null,
      lastSeenAt: null,
    };

    it('shows when it expires, and that it works once', async () => {
      const { api } = fakeApi([waiting]);
      render(<DeploymentsSection api={api} />);
      expect(await screen.findByText('K7M4P2QR')).toBeInTheDocument();
      expect(screen.getByText(/works once/)).toBeInTheDocument();
      expect(screen.getByText(/Expires in/)).toBeInTheDocument();
    });

    it('issues a fresh one on request', async () => {
      const { api } = fakeApi([waiting]);
      render(<DeploymentsSection api={api} />);
      await screen.findByText('K7M4P2QR');
      await userEvent.click(screen.getByRole('button', { name: 'New code' }));
      await waitFor(() => expect(api.pairingCode).toHaveBeenCalledTimes(2));
    });

    it('says so rather than leaving a dead code looking valid', async () => {
      const { api } = fakeApi([waiting], {
        pairingCode: vi.fn(async () => ({
          code: 'K7M4P2QR',
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        })),
      });
      render(<DeploymentsSection api={api} />);
      expect(await screen.findByText(/That code expired/)).toBeInTheDocument();
      expect(screen.queryByText('K7M4P2QR')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New code' })).toBeInTheDocument();
    });

    /** The route is being built in parallel; its absence is not a broken screen. */
    it('keeps the download and the command line when the route is missing', async () => {
      const { api } = fakeApi([waiting], {
        pairingCode: vi.fn(async () => {
          throw new ApiRequestError(404, 'not_found', 'Not found');
        }),
      });
      render(<DeploymentsSection api={api} />);
      expect(await screen.findByText(/cannot issue pairing codes yet/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Download for/ })).toBeInTheDocument();
      expect(screen.getByText('Install from a command line instead')).toBeInTheDocument();
    });

    /** A machine that has checked in has already spent a code. */
    it('is not offered to a machine that is already paired', async () => {
      const { api } = fakeApi([online]);
      render(<DeploymentsSection api={api} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Install Agent' }));
      expect(await screen.findByText(/is paired/)).toBeInTheDocument();
      expect(api.pairingCode).not.toHaveBeenCalled();
    });
  });

  it('takes a private key instead of a password', async () => {
    const { api } = fakeApi([]);
    render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /Deploy over SSH/ }));
    await userEvent.click(screen.getByRole('tab', { name: 'Private key' }));
    expect(screen.getByPlaceholderText('-----BEGIN OPENSSH PRIVATE KEY-----')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});
