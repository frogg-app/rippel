/**
 * rippel's side of the conversation with a rippel agent.
 *
 * Thin on purpose: the agent's API is already the vocabulary this feature
 * needs, so this module adds only the three things a route should not repeat —
 * the token header, a timeout, and turning a transport failure into a typed
 * error the routes can map to a status code.
 *
 * `fetchImpl` is injectable throughout so the routes can be tested against a
 * scripted agent, the same way backends/storage.ts tests its helper.
 */

import type { AgentPlatform, AgentTask, ComfyState, Engine, SdcppState } from '@comfy/shared';
import { tunnelAgentUrl } from './tunnel.js';
import { env } from '../env.js';

export class AgentError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'unauthorized' | 'busy' | 'refused',
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface AgentPingResult {
  ok: true;
  version: string;
  platform: AgentPlatform;
  hostname: string;
}

export interface AgentStatusResult extends AgentPingResult {
  comfy: ComfyState;
  /** Agent 0.5+; absent from older agents, which run ComfyUI only. */
  engine?: Engine;
  sdcpp?: SdcppState;
  accelerator: 'cuda' | 'rocm' | 'cpu';
  tasks: AgentTask[];
}

export interface AgentTarget {
  agentUrl?: string;
  host: string;
  agentPort: number;
  token: string;
}

export interface ModelMoveRequest { from: string; to: string }
export interface ModelDownloadRequest { url: string; path: string; sha256: string; sizeBytes?: number }

export interface AgentClient {
  approveModelHost(target: AgentTarget, taskId: string, body: { hostname: string; approve: boolean }): Promise<{ ok: true }>;
  setVaeOnGpu(target: AgentTarget, onGpu: boolean): Promise<AgentTask>;
  setMemoryMode(target: AgentTarget, mode: 'auto' | 'ram'): Promise<AgentTask>;
  /** Re-tests the GPU and repairs the torch build when the test fails. */
  repairGpu(target: AgentTarget): Promise<AgentTask>;
  updateAgent(target: AgentTarget, sha256: string): Promise<AgentTask>;
  moveModel(target: AgentTarget, body: ModelMoveRequest): Promise<AgentTask>;
  /** Deletes one file under models/; answers only once it is gone (or was never there). */
  deleteModel(target: AgentTarget, path: string): Promise<{ deleted: string; missing: boolean }>;
  downloadModel(target: AgentTarget, body: ModelDownloadRequest): Promise<AgentTask>;
  ping(target: AgentTarget): Promise<AgentPingResult>;
  status(target: AgentTarget): Promise<AgentStatusResult>;
  task(target: AgentTarget, id: string, since: number): Promise<{ task: AgentTask; logOffset: number }>;
  installComfy(target: AgentTarget, accelerator: string): Promise<AgentTask>;
  updateComfy(target: AgentTarget): Promise<AgentTask>;
  power(target: AgentTarget, action: 'start' | 'stop' | 'restart'): Promise<unknown>;
  installHelper(
    target: AgentTarget,
    files: { name: string; content: string }[],
    storageToken: string,
  ): Promise<AgentTask>;
  comfyLog(target: AgentTarget): Promise<string[]>;
  /** The second engine (agent 0.5+). `build` is auto|cpu|vulkan|cuda|rocm. */
  installSdcpp(target: AgentTarget, build: string): Promise<AgentTask>;
  sdcppPower(target: AgentTarget, action: 'start' | 'stop' | 'restart'): Promise<unknown>;
  sdcppLog(target: AgentTarget): Promise<string[]>;
  setEngine(target: AgentTarget, engine: Engine): Promise<{ engine: Engine }>;
}

/**
 * The agent's address as rippel dials it.
 *
 * Use an explicitly configured HTTPS reverse proxy, or the direct LAN address.
 */
export function agentUrl(target: AgentTarget, path: string): string {
  return `${tunnelAgentUrl(target.token) ?? target.agentUrl ?? `http://${target.host}:${target.agentPort}`}${path}`;
}

export function makeAgentClient(opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): AgentClient {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const timeoutMs = opts.timeoutMs ?? env.deploy.timeoutMs;

  async function call<T>(
    target: AgentTarget,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(agentUrl(target, path), {
        method: init.method ?? 'GET',
        redirect: 'error',
        headers: {
          'X-Rippel-Agent-Token': target.token,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = controller.signal.aborted;
      throw new AgentError(
        'unreachable',
        aborted
          ? `${target.host} did not answer within ${Math.round(timeoutMs / 1000)}s.`
          : `Could not reach the agent on ${target.host}:${target.agentPort}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = (await res.json().catch(() => null)) as
      | (T & { error?: string; message?: string })
      | null;

    if (!res.ok) {
      if (res.status === 503 && tunnelAgentUrl(target.token)) {
        throw new AgentError('unreachable', 'The agent tunnel is disconnected. Waiting for the agent to reconnect.', 503);
      }
      const message = payload?.message ?? `The agent answered ${res.status}.`;
      if (res.status === 401) throw new AgentError('unauthorized', message, 401);
      if (res.status === 409) throw new AgentError('busy', message, 409);
      throw new AgentError('refused', message, res.status);
    }
    return payload as T;
  }

  return {
    approveModelHost: (target, taskId, body) => call(target, `/agent/tasks/${encodeURIComponent(taskId)}/host-approval`, { method: 'POST', body }),
    setVaeOnGpu: (target, onGpu) => call(target, '/agent/vae', { method: 'POST', body: { onGpu } }),
    repairGpu: async (target) => (await call<{ task: AgentTask }>(target, '/agent/gpu/repair', { method: 'POST' })).task,
    setMemoryMode: async (target, mode) => (await call<{ task: AgentTask }>(target, '/agent/memory', { method: 'POST', body: { mode } })).task,
    updateAgent: async (target, sha256) => (await call<{ task: AgentTask }>(target, '/agent/update', { method: 'POST', body: { sha256 } })).task,
    moveModel: async (target, body) =>
      (await call<{ task: AgentTask }>(target, '/agent/models/move', { method: 'POST', body })).task,
    deleteModel: (target, path) => call(target, '/agent/models/delete', { method: 'POST', body: { path } }),
    downloadModel: async (target, body) =>
      (await call<{ task: AgentTask }>(target, '/agent/models/download', { method: 'POST', body })).task,
    ping: (target) => call<AgentPingResult>(target, '/agent/ping'),
    status: (target) => call<AgentStatusResult>(target, '/agent/status'),
    task: (target, id, since) =>
      call<{ task: AgentTask; logOffset: number }>(
        target,
        `/agent/tasks/${encodeURIComponent(id)}?since=${since}`,
      ),
    installComfy: async (target, accelerator) =>
      (
        await call<{ task: AgentTask }>(target, '/agent/comfyui/install', {
          method: 'POST',
          body: { accelerator },
        })
      ).task,
    updateComfy: async (target) =>
      (await call<{ task: AgentTask }>(target, '/agent/comfyui/update', { method: 'POST' })).task,
    power: (target, action) => call(target, `/agent/comfyui/${action}`, { method: 'POST' }),
    installHelper: async (target, files, storageToken) =>
      (
        await call<{ task: AgentTask }>(target, '/agent/helper/install', {
          method: 'POST',
          body: { files, storageToken },
        })
      ).task,
    comfyLog: async (target) => (await call<{ log: string[] }>(target, '/agent/comfyui/log')).log,
    installSdcpp: async (target, build) =>
      (await call<{ task: AgentTask }>(target, '/agent/sdcpp/install', { method: 'POST', body: { build } })).task,
    sdcppPower: (target, action) => call(target, `/agent/sdcpp/${action}`, { method: 'POST' }),
    sdcppLog: async (target) => (await call<{ log: string[] }>(target, '/agent/sdcpp/log')).log,
    setEngine: (target, engine) => call(target, '/agent/engine', { method: 'POST', body: { engine } }),
  };
}

export const agentClient = makeAgentClient();
