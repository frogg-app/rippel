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

import type { AgentPlatform, AgentTask, ComfyState } from '@comfy/shared';
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
  accelerator: 'cuda' | 'rocm' | 'cpu';
  tasks: AgentTask[];
}

export interface AgentTarget {
  host: string;
  agentPort: number;
  token: string;
}

export interface AgentClient {
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
}

/**
 * The agent's address as rippel dials it.
 *
 * Always http and always by host:port — the agent has no certificate and lives
 * on the same LAN as the ComfyUI it manages, which is the same trust boundary
 * the rest of this app already draws around backends.
 */
export function agentUrl(target: AgentTarget, path: string): string {
  return `http://${target.host}:${target.agentPort}${path}`;
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
      const message = payload?.message ?? `The agent answered ${res.status}.`;
      if (res.status === 401) throw new AgentError('unauthorized', message, 401);
      if (res.status === 409) throw new AgentError('busy', message, 409);
      throw new AgentError('refused', message, res.status);
    }
    return payload as T;
  }

  return {
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
  };
}

export const agentClient = makeAgentClient();
