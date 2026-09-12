/**
 * Deployments, for the Settings modal. Admin only on the server.
 *
 * Two things here are not in the backends client. Long actions — installing
 * ComfyUI, running an SSH install — return a handle rather than a result, so
 * this module also exposes the polling read that follows one. And several
 * reads take a `since` offset so a fifteen-minute pip log is fetched once,
 * not once per poll.
 */
import type {
  AgentPlatform,
  AgentProbe,
  AgentRelease,
  AgentTask,
  ComfyState,
  Deployment,
  DeploymentInput,
  MemoryProfile,
  SshInstallInput,
  SshRun,
  Uuid,
} from '@comfy/shared';
import { ApiRequestError } from './api';

const BASE = '/api';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiRequestError(0, 'unreachable', 'Cannot reach the rippel server.');
  }
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload ?? {}) as { error?: string; message?: string; field?: string };
    const thrown = new ApiRequestError(
      response.status,
      error.error ?? 'error',
      error.message ?? 'Something went wrong.',
    ) as ApiRequestError & { field?: string };
    if (error.field) thrown.field = error.field;
    throw thrown;
  }
  return payload as T;
}

/**
 * One agent binary this rippel has on disk, ready to hand to a browser.
 *
 * `target` is the thing to switch on, not `platform`: there are two macOS
 * builds and they differ only by `arch`, so anything selecting by platform
 * alone silently hands an Intel Mac the Apple-silicon binary.
 *
 * `fileName` carries the deployment's address and token encoded into the name
 * itself, which is what makes opening the file the whole install.
 */
export interface AgentBinary {
  target: string;
  platform: AgentPlatform;
  arch: 'amd64' | 'arm64';
  label: string;
  sizeBytes: number;
  url: string;
  fileName: string;
}

export interface InstallInstructions {
  serverUrl: string;
  token: string;
  /**
   * The binaries this rippel actually has built. Empty is a normal state — a
   * rippel run from a checkout has none until the agent release is built — so
   * the panel falls back to the GitHub release links.
   */
  binaries: AgentBinary[];
  release: AgentRelease;
}

/**
 * A one-time pairing code, and the moment it stops working.
 *
 * Both fields come straight from `POST /deployments/:id/pairing-code`. The
 * code is single-use and short-lived, and issuing a new one for a deployment
 * invalidates any outstanding code for it — so the panel showing it has to
 * treat it as perishable rather than as a fact about the machine.
 */
export interface PairingCode {
  code: string;
  /** ISO-8601. */
  expiresAt: string;
  /**
   * The address the machine should be pointed at, and one-liners that carry
   * this code. They live here rather than on the install route because a
   * command containing a credential is only meaningful while that credential
   * is alive — and a polled GET must not mint one.
   */
  serverUrl: string;
  commands: { linux: string; darwin: string; win32: string };
}

/**
 * Develop against a fake code before the route exists.
 *
 * The endpoint is being built in parallel, so this is a switch rather than a
 * branch left in the code: set `rippel.mockPairing` to `on` in localStorage
 * and the client answers itself. It is off unless deliberately turned on, and
 * nothing else in the module consults it.
 */
function mockPairingEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem('rippel.mockPairing') === 'on';
  } catch {
    // A browser that refuses storage is simply not in mock mode.
    return false;
  }
}

/** No O/0 and no I/1/l, so a code can be read down a phone line. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function mockCode(): PairingCode {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const origin = window.location.origin;
  const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return {
    code,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    serverUrl: origin,
    commands: {
      linux: `curl -fsSL -o /tmp/rippel-agent '${origin}/api/deployments/agent/linux-amd64' && chmod +x /tmp/rippel-agent && /tmp/rippel-agent install --server '${origin}' --code '${code}'`,
      darwin: `curl -fsSL -o /tmp/rippel-agent '${origin}/api/deployments/agent/macos-arm64' && chmod +x /tmp/rippel-agent && /tmp/rippel-agent install --server '${origin}' --code '${code}'`,
      win32: `powershell -ExecutionPolicy Bypass -Command "& { iwr -UseBasicParsing '${origin}/api/deployments/agent/windows-amd64' -OutFile rippel-agent.exe; & ./rippel-agent.exe install --server '${origin}' --code '${code}' }"`,
    },
  };
}

export interface LiveStatus {
  comfy: ComfyState;
  accelerator: 'cuda' | 'rocm' | 'cpu';
  tasks: AgentTask[];
}

export interface DeploymentsApi {
  list(signal?: AbortSignal): Promise<Deployment[]>;
  create(input: DeploymentInput): Promise<Deployment>;
  remove(id: Uuid): Promise<void>;
  probe(id: Uuid): Promise<AgentProbe>;
  status(id: Uuid, signal?: AbortSignal): Promise<LiveStatus>;
  instructions(id: Uuid, signal?: AbortSignal): Promise<InstallInstructions>;
  /** Issue a fresh code, invalidating any outstanding one for this machine. */
  pairingCode(id: Uuid, signal?: AbortSignal): Promise<PairingCode>;
  releases(signal?: AbortSignal): Promise<AgentRelease>;
  installComfy(id: Uuid, accelerator: string): Promise<AgentTask>;
  updateComfy(id: Uuid): Promise<AgentTask>;
  power(id: Uuid, action: 'start' | 'stop' | 'restart'): Promise<unknown>;
  /**
   * Set how hard this machine should try to fit a job in graphics memory.
   * Resolves even when the machine is asleep — the choice is stored either way
   * and `applied` says whether the machine heard about it yet.
   */
  setMemory(
    id: Uuid,
    profile: MemoryProfile,
    cpuVae: boolean,
  ): Promise<{ applied: boolean; restarted: boolean; comfyArgs: string; message?: string }>;
  installHelper(id: Uuid): Promise<AgentTask>;
  task(id: Uuid, taskId: string, since: number): Promise<{ task: AgentTask; logOffset: number }>;
  registerBackend(id: Uuid, name?: string): Promise<{ deployment: Deployment; adopted: boolean }>;
  sshInstall(input: SshInstallInput & { platform?: string; comfyPort?: number }): Promise<{
    run: SshRun;
    deployment: Deployment;
  }>;
  run(runId: string, since: number): Promise<{ run: SshRun; logOffset: number }>;
}

export const deploymentsApi: DeploymentsApi = {
  list: async (signal) =>
    (await request<{ deployments: Deployment[] }>('/deployments', { signal })).deployments,
  create: async (input) =>
    (await request<{ deployment: Deployment }>('/deployments', { method: 'POST', body: input }))
      .deployment,
  remove: (id) => request<void>(`/deployments/${id}`, { method: 'DELETE' }),
  probe: (id) => request<AgentProbe>(`/deployments/${id}/probe`, { method: 'POST' }),
  status: (id, signal) => request<LiveStatus>(`/deployments/${id}/status`, { signal }),
  instructions: (id, signal) => request<InstallInstructions>(`/deployments/${id}/install`, { signal }),
  pairingCode: async (id, signal) =>
    mockPairingEnabled()
      ? mockCode()
      : request<PairingCode>(`/deployments/${id}/pairing-code`, { method: 'POST', signal }),
  releases: async (signal) =>
    (await request<{ release: AgentRelease }>('/deployments/releases', { signal })).release,
  installComfy: async (id, accelerator) =>
    (
      await request<{ task: AgentTask }>(`/deployments/${id}/comfyui/install`, {
        method: 'POST',
        body: { accelerator },
      })
    ).task,
  updateComfy: async (id) =>
    (await request<{ task: AgentTask }>(`/deployments/${id}/comfyui/update`, { method: 'POST' })).task,
  power: (id, action) => request(`/deployments/${id}/comfyui/${action}`, { method: 'POST' }),
  setMemory: (id, profile, cpuVae) =>
    request(`/deployments/${id}/memory`, { method: 'POST', body: { profile, cpuVae } }),
  installHelper: async (id) =>
    (await request<{ task: AgentTask }>(`/deployments/${id}/helper/install`, { method: 'POST' })).task,
  task: (id, taskId, since) =>
    request<{ task: AgentTask; logOffset: number }>(
      `/deployments/${id}/tasks/${encodeURIComponent(taskId)}?since=${since}`,
    ),
  registerBackend: (id, name) =>
    request<{ deployment: Deployment; adopted: boolean }>(`/deployments/${id}/backend`, {
      method: 'POST',
      body: name ? { name } : {},
    }),
  sshInstall: (input) =>
    request<{ run: SshRun; deployment: Deployment }>('/deployments/ssh-install', {
      method: 'POST',
      body: input,
    }),
  run: (runId, since) =>
    request<{ run: SshRun; logOffset: number }>(`/deployments/runs/${runId}?since=${since}`),
};
