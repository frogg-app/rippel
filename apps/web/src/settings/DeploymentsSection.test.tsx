import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  binaries: [
    {
      target: 'windows-amd64',
      platform: 'win32',
      arch: 'amd64',
      label: 'Windows',
      sizeBytes: 7599104,
      url: 'http://192.168.1.9:4000/api/deployments/agent/windows-amd64',
      fileName: 'rippel-agent-windows-amd64.exe',
    },
    {
      target: 'macos-arm64',
      platform: 'darwin',
      arch: 'arm64',
      label: 'macOS (Apple silicon)',
      sizeBytes: 6964018,
      url: 'http://192.168.1.9:4000/api/deployments/agent/macos-arm64',
      fileName: 'rippel-agent-macos-arm64',
    },
    {
      target: 'macos-amd64',
      platform: 'darwin',
      arch: 'amd64',
      label: 'macOS (Intel)',
      sizeBytes: 7528896,
      url: 'http://192.168.1.9:4000/api/deployments/agent/macos-amd64',
      fileName: 'rippel-agent-macos-amd64',
    },
    {
      target: 'linux-amd64',
      platform: 'linux',
      arch: 'amd64',
      label: 'Linux',
      sizeBytes: 7372960,
      url: 'http://192.168.1.9:4000/api/deployments/agent/linux-amd64',
      fileName: 'rippel-agent-linux-amd64',
    },
  ],
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
      serverUrl: 'https://rippel.test',
      commands: {
        linux: "curl -fsSL -o /tmp/rippel-agent 'https://rippel.test/api/deployments/agent/linux-amd64' && chmod +x /tmp/rippel-agent && /tmp/rippel-agent install --server 'https://rippel.test' --code 'K7M4P2QR'",
        darwin: "curl -fsSL -o /tmp/rippel-agent 'https://rippel.test/api/deployments/agent/macos-arm64' && chmod +x /tmp/rippel-agent && /tmp/rippel-agent install --server 'https://rippel.test' --code 'K7M4P2QR'",
        win32: "$agent = Join-Path $env:TEMP 'rippel-agent.exe'; iwr -UseBasicParsing 'https://rippel.test/api/deployments/agent/windows-amd64' -OutFile $agent; & $agent install --server 'https://rippel.test' --code 'K7M4P2QR'",
        win32Cmd: "powershell -ExecutionPolicy Bypass -Command \"& { iwr -UseBasicParsing 'https://rippel.test/api/deployments/agent/windows-amd64' -OutFile rippel-agent.exe }\"",
      },
    })),
    releases: vi.fn(async () => instructions.release),
    installComfy: vi.fn(async () => done()),
    setVaeOnGpu: vi.fn(async () => done({kind: 'set-memory'})),
    setMemoryMode: vi.fn(async () => done({kind: 'set-memory'})),
    updateAgent: vi.fn(),
    repairGpu: vi.fn(async () => done({ kind: 'repair-gpu' })),
    updateComfy: vi.fn(async () => done({ kind: 'update-comfyui' })),
    power: vi.fn(async () => ({ started: true })),
    installSdcpp: vi.fn(async () => done({ kind: 'install-sdcpp', log: ['stable-diffusion.cpp installed.'] })),
    sdcppPower: vi.fn(async () => ({ started: true })),
    setEngine: vi.fn(async (id, engine) => ({ ...rows.find((r) => r.id === id)!, engine })),
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
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('Not enabled')).toBeInTheDocument();
  });

  it('shows disk as used/total, like GPU and RAM', async () => {
    const { api } = fakeApi();
    render(<DeploymentsSection api={api} />);

    // 2000e9 total, 400e9 free: 1600e9 used, in GiB to one decimal.
    expect(await screen.findByText('1490.1/1862.6 GB')).toBeInTheDocument();
    expect(screen.getByText('disk')).toBeInTheDocument();
    expect(screen.queryByText(/free of/)).not.toBeInTheDocument();
  });

  it.each([
    { lastSeenAt: online.lastSeenAt, agentVersion: null },
    { lastSeenAt: null, agentVersion: '0.3.0' },
  ])('hides install options for a previously installed offline agent: %j', async (identity) => {
    const { api } = fakeApi([{ ...online, ...identity, status: 'offline' }]);
    render(<DeploymentsSection api={api} />);
    await screen.findByText('studio-4090');
    expect(screen.queryByRole('button', { name: 'Install Agent' })).not.toBeInTheDocument();
    expect(api.instructions).not.toHaveBeenCalled();
  });

  it('uses amber when the agent is online but its engine is stopped', async () => {
    const { api } = fakeApi([{ ...online, comfy: { ...COMFY, running: false } }]);
    render(<DeploymentsSection api={api} />);
    expect(await screen.findByText('Engine stopped')).toHaveAttribute('data-status', 'warning');
    expect(screen.getByText('Agent online')).toBeInTheDocument();
  });

  it('offers Install engine when there is none, and the run controls when there is', async () => {
    const bare = { ...online, comfy: { ...COMFY, installed: false, running: false, helperInstalled: false, helperReady: false } };
    const { api } = fakeApi([bare]);
    const { unmount } = render(<DeploymentsSection api={api} />);
    expect(await screen.findByRole('button', { name: 'Install engine' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restart engine/ })).not.toBeInTheDocument();
    unmount();

    render(<DeploymentsSection api={fakeApi().api} />);
    expect(await screen.findByRole('button', { name: 'Restart engine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    // A helper that is already answering needs no button offering to install it.
    expect(screen.queryByRole('button', { name: /storage helper/ })).not.toBeInTheDocument();
  });

  it('shows stable-diffusion.cpp controls when that engine is active, and installs it on request', async () => {
    const sdcppMachine: Deployment = {
      ...online,
      agentVersion: '0.5.0',
      engine: 'sdcpp',
      sdcpp: { installed: false, running: false, path: null, version: null, build: null, port: 8190, modelDirs: [], model: null, diskFree: null, diskTotal: null },
    };
    const { api } = fakeApi([sdcppMachine]);
    const { unmount } = render(<DeploymentsSection api={api} />);
    expect(await screen.findByText('Setup needed')).toBeInTheDocument();
    // ComfyUI's own controls stay out of the way while the other engine is chosen.
    expect(screen.queryByRole('button', { name: 'Enable file access' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Install engine' }));
    await waitFor(() => expect(api.installSdcpp).toHaveBeenCalledWith('d1', 'auto'));
    expect(await screen.findByText(/stable-diffusion\.cpp installed\./)).toBeInTheDocument();
    unmount();

    const running: Deployment = {
      ...sdcppMachine,
      backendId: 'b1',
      backendName: 'studio-4090',
      sdcpp: { ...sdcppMachine.sdcpp!, installed: true, running: true, build: 'vulkan', version: 'master-987-a77d362', path: '/home/steve/.rippel-agent/sdcpp',
        model: { state: 'ready', recipe: 'z-image-turbo', models: { diffusion_model: 'diffusion_models/z_image_turbo-Q3_K.gguf' }, error: null } },
    };
    render(<DeploymentsSection api={fakeApi([running]).api} />);
    expect(await screen.findByRole('button', { name: 'Restart engine' })).toBeInTheDocument();
    expect(screen.getByText(/z-image-turbo/)).toBeInTheDocument();
    expect(screen.getByText(/vulkan/)).toBeInTheDocument();
    expect(screen.getByText('Enabled', { selector: 'dd' })).toBeInTheDocument();
  });

  it('switches the engine through the API and keeps the card in step', async () => {
    const { api } = fakeApi([{ ...online, agentVersion: '0.5.0', engine: 'comfyui', sdcpp: null }]);
    render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('combobox', { name: 'Engine' }));
    await userEvent.click(await screen.findByRole('option', { name: 'stable-diffusion.cpp' }));
    await waitFor(() => expect(api.setEngine).toHaveBeenCalledWith('d1', 'sdcpp'));
    expect(await screen.findByText('Setup needed')).toBeInTheDocument();
  });

  it('offers the helper when it is missing, and follows the install to its log', async () => {
    const noHelper = { ...online, comfy: { ...COMFY, helperInstalled: false, helperReady: false } };
    const { api } = fakeApi([noHelper]);
    render(<DeploymentsSection api={api} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Enable file access' }));
    await waitFor(() => expect(api.installHelper).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText(/ComfyUI installed\./)).toBeInTheDocument();
  });

  it('registers the ComfyUI as a backend', async () => {
    const { api } = fakeApi();
    render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Enable generation' }));
    await waitFor(() => expect(api.registerBackend).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText('Enabled', { selector: 'dd' })).toBeInTheDocument();
  });

  it('re-pairs a connected machine with a fresh code, keeping it the same machine', async () => {
    const { api } = fakeApi();
    render(<DeploymentsSection api={api} />);
    await screen.findByText('studio-4090');
    // A connected machine is not asked for a code until someone wants one.
    expect(api.pairingCode).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Re-pair' }));
    expect(await screen.findByText('Pair studio-4090 again')).toBeInTheDocument();
    expect(await screen.findByText('K7M4P2QR')).toBeInTheDocument();
    expect(api.pairingCode).toHaveBeenCalledWith('d1', expect.anything());
    expect(api.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel re-pair' }));
    expect(screen.queryByText('Pair studio-4090 again')).not.toBeInTheDocument();
  });

  it('asks twice before removing a machine', async () => {
    const { api } = fakeApi();
    render(<DeploymentsSection api={api} />);
    const remove = await screen.findByRole('button', { name: 'Remove studio-4090' });
    expect(remove.closest('footer')).not.toBeNull();
    expect(remove).toHaveAttribute('data-variant', 'danger-soft');
    await userEvent.click(remove);
    expect(api.remove).not.toHaveBeenCalled();
    const ask = screen.getByRole('alertdialog', { name: 'Remove this backend?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Remove' }));
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

  it('shows a successful Test as online immediately, then refreshes ComfyUI details', async () => {
    let finishStatus!: (value: Awaited<ReturnType<DeploymentsApi['status']>>) => void;
    const { api } = fakeApi([{ ...online, status: 'offline', comfy: null }], {
      probe: vi.fn(async () => ({ ok: true, latencyMs: 8, version: '0.3.0', platform: 'win32' as const })),
      status: vi.fn<DeploymentsApi['status']>(() => new Promise((resolve) => { finishStatus = resolve; })),
    });
    render(<DeploymentsSection api={api} />);
    expect(await screen.findByText('offline')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Agent online')).toBeInTheDocument();
    expect(screen.getByText('Setup needed')).toHaveAttribute('data-status', 'warning');
    expect(screen.queryByText(/The agent has stopped answering/)).not.toBeInTheDocument();
    expect(screen.getByText('Windows')).toBeInTheDocument();
    expect(screen.getByText('agent 0.3.0')).toBeInTheDocument();
    expect(api.status).toHaveBeenCalledWith('d1');
    await act(async () => finishStatus({ comfy: COMFY, accelerator: 'cuda', tasks: [] }));
    expect(screen.getByText(/running/, { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart engine' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('marks a failed Test offline immediately and disables agent actions', async () => {
    const { api } = fakeApi([online], {
      probe: vi.fn(async () => ({ ok: false, latencyMs: 8, error: 'Connection refused' })),
    });
    render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(screen.getByText(/The agent has stopped answering/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('aria-disabled', 'true');
    expect(api.status).not.toHaveBeenCalled();
  });

  it('keeps the successful ping and previous ComfyUI details if the detail refresh fails', async () => {
    const { api } = fakeApi([{ ...online, status: 'offline' }], {
      status: vi.fn(async () => { throw new Error('Status timed out.'); }),
    });
    render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('online')).toBeInTheDocument();
    expect(screen.getByText(/running/, { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText(/engine status could not be refreshed/)).toHaveTextContent('Status timed out.');
  });

  it('does not let an older fleet poll revert a successful Test', async () => {
    const offline: Deployment = { ...online, status: 'offline' };
    let finishList!: (value: Deployment[]) => void;
    const list = vi.fn<DeploymentsApi['list']>()
      .mockResolvedValueOnce([offline])
      .mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }));
    const { api } = fakeApi([offline], { list });
    vi.useFakeTimers();
    try {
      const { unmount } = render(<DeploymentsSection api={api} />);
      await act(async () => {});
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(list).toHaveBeenCalledTimes(2);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test' })); });
      expect(screen.getByText('online')).toBeInTheDocument();
      await act(async () => finishList([offline]));
      expect(screen.getByText('online')).toBeInTheDocument();
      expect(screen.queryByText('offline')).not.toBeInTheDocument();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the manual path a command carrying the pairing code', async () => {
    const { api } = fakeApi([]);
    render(<DeploymentsSection api={api} />);

    await userEvent.click(await screen.findByRole('button', { name: /Install with one command/ }));
    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'garage-box');
    await userEvent.click(screen.getByRole('button', { name: /Register and show the command/ }));

    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ name: 'garage-box', host: 'pending' }));
    const command = await screen.findByText(/curl -fsSL/);
    // A pairing code, not a token: the command is only good while the code is,
    // which is why it comes back with the code rather than from a polled GET.
    expect(command).toHaveTextContent('--code');

    // The Windows tab shows the PowerShell form of the same thing.
    await userEvent.click(screen.getByRole('tab', { name: 'Windows' }));
    expect(await screen.findByText(/Join-Path \$env:TEMP/)).toBeInTheDocument();
    // And Command Prompt gets its own line beside it, since neither pastes into the other.
    expect(screen.getByText(/^powershell -ExecutionPolicy Bypass/)).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: /Register and show downloads/ }));

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

    expect(screen.queryByText('Install from a command line instead')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Copy Install Agent')).not.toBeInTheDocument();

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
  it('explains why Install engine cannot be pressed yet', async () => {
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

    const install = await screen.findByRole('button', { name: 'Install engine' });
    expect(install).toHaveAttribute('aria-disabled', 'true');

    // The explanation is associated with the button, not hidden in a title.
    const tip = document.getElementById(install.getAttribute('aria-describedby')!);
    expect(tip).toHaveTextContent(/Waiting for the agent to check in/);

    // The card says the same thing in its own words, with the next move in it.
    expect(screen.getByText(/Install the agent on this machine to continue/)).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole('button', { name: /Install with one command/ }));
    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'garage-box');
    await userEvent.click(screen.getByRole('button', { name: /Register and show the command/ }));

    expect(await screen.findByText(/curl -fsSL/)).toBeInTheDocument();
    // A LAN address in plaintext is how everyone runs this; no warning.
    expect(screen.queryByText(/carries a pairing code/)).not.toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole('button', { name: /Install with one command/ }));
    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'garage-box');
    await userEvent.click(screen.getByRole('button', { name: /Register and show the command/ }));

    expect(await screen.findByText(/carries a pairing code/)).toBeInTheDocument();
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
    await userEvent.type(screen.getByPlaceholderText('192.168.1.50'), '10.0.0.7');
    await userEvent.type(screen.getByPlaceholderText('studio-4090'), 'garage-box');
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
          serverUrl: 'https://rippel.test',
          commands: {
        linux: "curl -fsSL -o /tmp/rippel-agent 'https://rippel.test/api/deployments/agent/linux-amd64' && chmod +x /tmp/rippel-agent && /tmp/rippel-agent install --server 'https://rippel.test' --code 'K7M4P2QR'",
        darwin: "curl -fsSL -o /tmp/rippel-agent 'https://rippel.test/api/deployments/agent/macos-arm64' && chmod +x /tmp/rippel-agent && /tmp/rippel-agent install --server 'https://rippel.test' --code 'K7M4P2QR'",
        win32: "$agent = Join-Path $env:TEMP 'rippel-agent.exe'; iwr -UseBasicParsing 'https://rippel.test/api/deployments/agent/windows-amd64' -OutFile $agent; & $agent install --server 'https://rippel.test' --code 'K7M4P2QR'",
        win32Cmd: "powershell -ExecutionPolicy Bypass -Command \"& { iwr -UseBasicParsing 'https://rippel.test/api/deployments/agent/windows-amd64' -OutFile rippel-agent.exe }\"",
      },
        })),
      });
      render(<DeploymentsSection api={api} />);
      expect(await screen.findByText(/That code expired/)).toBeInTheDocument();
      expect(screen.queryByText('K7M4P2QR')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New code' })).toBeInTheDocument();
    });

    /** The route is being built in parallel; its absence is not a broken screen. */
    it('keeps the download when the pairing route is missing', async () => {
      const { api } = fakeApi([waiting], {
        pairingCode: vi.fn(async () => {
          throw new ApiRequestError(404, 'not_found', 'Not found');
        }),
      });
      render(<DeploymentsSection api={api} />);
      expect(await screen.findByText(/cannot issue pairing codes yet/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Download for/ })).toBeInTheDocument();
      expect(screen.queryByText('Install from a command line instead')).not.toBeInTheDocument();
    });

    /** A machine that has checked in has already spent a code. */
    it('is not offered to a machine that is already paired', async () => {
      const { api } = fakeApi([online]);
      render(<DeploymentsSection api={api} />);
      await screen.findByText('studio-4090');
      expect(screen.queryByRole('button', { name: 'Install Agent' })).not.toBeInTheDocument();
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


describe('agent update progress', () => {
  it('waits for restart, then refreshes the version and engine automatically', async () => {
    vi.useFakeTimers();
    const poll = vi.fn()
      .mockResolvedValueOnce({ task: done({ kind: 'update-agent' }), logOffset: 2 })
      .mockRejectedValueOnce(new ApiRequestError(502, 'unreachable', 'Offline'))
      .mockRejectedValue(new ApiRequestError(404, 'not_found', 'Task not found'));
    const { api } = fakeApi([online], {
      updateAgent: vi.fn(async () => done({ kind: 'update-agent', status: 'running' })),
      task: poll,
      probe: vi.fn(async () => ({ ok: true, version: '0.4.0', platform: 'linux' as const, latencyMs: 5 })),
      status: vi.fn(async () => ({ comfy: { ...COMFY, running: false }, accelerator: 'cuda' as const, tasks: [] })),
    });
    const view = render(<DeploymentsSection api={api} />);
    try {
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Update agent' }));
      await act(async () => {});
      expect(screen.getByText('Updating agent…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      expect(api.probe).not.toHaveBeenCalled();
      expect(screen.queryByText('Agent updated.')).not.toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(4000));
      expect(screen.getByText('Agent updated.')).toBeInTheDocument();
      expect(screen.getByText('agent 0.4.0')).toBeInTheDocument();
      expect(screen.getByText('Engine stopped')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Test' })).not.toBeDisabled();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it('reports failed updates without claiming a restart succeeded', async () => {
    const { api } = fakeApi([online], {
      updateAgent: vi.fn(async () => done({ kind: 'update-agent', status: 'failed', error: 'checksum mismatch' })),
    });
    render(<DeploymentsSection api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Update agent' }));
    expect(await screen.findByText('Agent update failed. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('Agent updated.')).not.toBeInTheDocument();
    expect(api.probe).not.toHaveBeenCalled();
  });

  it('stops update polling when settings closes', async () => {
    vi.useFakeTimers();
    const { api } = fakeApi([online], {
      updateAgent: vi.fn(async () => done({ kind: 'update-agent', status: 'running' })),
    });
    const view = render(<DeploymentsSection api={api} />);
    try {
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Update agent' }));
      await act(async () => {});
      view.unmount();
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(api.task).not.toHaveBeenCalled();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it('ends the spinner if the agent never restarts', async () => {
    vi.useFakeTimers();
    const { api } = fakeApi([online], {
      updateAgent: vi.fn(async () => done({ kind: 'update-agent' })),
    });
    const view = render(<DeploymentsSection api={api} />);
    try {
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Update agent' }));
      await act(async () => vi.advanceTimersByTimeAsync(6 * 60_000));
      expect(screen.getByText('The agent has not reconnected yet. Check that the machine is awake.')).toBeInTheDocument();
      expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
      expect(screen.queryByText('Agent updated.')).not.toBeInTheDocument();
    } finally { view.unmount(); vi.useRealTimers(); }
  });
});

it('requires an agent update for memory settings on older agents', async () => {
 const {api}=fakeApi();render(<DeploymentsSection api={api}/>);
 expect(await screen.findByLabelText('Use system memory')).toBeDisabled();
 expect(screen.getByText('Update the agent to change memory usage.')).toBeInTheDocument();
});

it('applies memory usage and refreshes engine state automatically', async () => {
 const comfy={...COMFY,memoryMode:'auto' as const};
 const {api}=fakeApi([{...online,comfy}],{status:vi.fn(async()=>({comfy:{...COMFY,memoryMode:'ram' as const},accelerator:'cuda' as const,tasks:[]}))});
 render(<DeploymentsSection api={api}/>);
 const select=await screen.findByLabelText('Use system memory');
 await userEvent.click(select);
 await userEvent.click(screen.getByRole('button',{name:'Apply memory and restart'}));
 await waitFor(()=>expect(api.setMemoryMode).toHaveBeenCalledWith('d1','ram'));
 await waitFor(()=>expect(api.status).toHaveBeenCalled());
 expect(select).toBeChecked();
});

it('saves memory settings without offering a restart for a stopped engine', async () => {
 const {api}=fakeApi([{...online,comfy:{...COMFY,running:false,memoryMode:'auto'}}]);
 render(<DeploymentsSection api={api}/>);
 await userEvent.click(await screen.findByLabelText('Use system memory'));
 expect(screen.getByRole('button',{name:'Apply memory'})).toBeEnabled();
 expect(screen.queryByRole('button',{name:'Apply memory and restart'})).not.toBeInTheDocument();
});

it('defaults system memory off and GPU VAE on, with independent saved choices', async () => {
 const {api}=fakeApi([{...online,comfy:{...COMFY,memoryMode:'auto',vaeOnGpu:true}}],{status:vi.fn(async()=>({comfy:{...COMFY,memoryMode:'auto' as const,vaeOnGpu:false},accelerator:'cuda' as const,tasks:[]}))});
 render(<DeploymentsSection api={api}/>);
 expect(await screen.findByLabelText('Use system memory')).not.toBeChecked();
 const vae=screen.getByLabelText('Decode images on the GPU (VAE)');expect(vae).toBeChecked();
 await userEvent.click(vae);
 await userEvent.click(screen.getByRole('button',{name:'Apply decoder setting and restart'}));
 await waitFor(()=>expect(api.setVaeOnGpu).toHaveBeenCalledWith('d1',false));
 expect(api.setMemoryMode).not.toHaveBeenCalled();
});

describe('GPU health', () => {
  const broken: Deployment = {
    ...online,
    comfy: { ...COMFY, gpuHealth: { state: 'unsupported', device: 'AMD Radeon(TM) Graphics', arch: 'gfx1036', detail: 'device kernel image is invalid' } },
  };

  it('says the GPU is not supported, with the error in the tooltip, and repairs in one click', async () => {
    const { api } = fakeApi([broken]);
    render(<DeploymentsSection api={api} />);
    const pill = await screen.findByText('GPU not supported by this build');
    expect(pill.getAttribute('title')).toContain('gfx1036');
    expect(pill.getAttribute('title')).toContain('device kernel image is invalid');
    fireEvent.click(screen.getByRole('button', { name: 'Repair GPU setup' }));
    await waitFor(() => expect(api.repairGpu).toHaveBeenCalledWith('d1'));
  });

  it('offers no repair when the GPU is ready', async () => {
    const { api } = fakeApi([{ ...online, comfy: { ...COMFY, gpuHealth: { state: 'ready', device: 'AMD Radeon RX 6900 XT' } } }]);
    render(<DeploymentsSection api={api} />);
    expect(await screen.findByText('GPU ready')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Repair GPU setup' })).not.toBeInTheDocument();
  });
});
