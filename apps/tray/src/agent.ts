import { invoke } from '@tauri-apps/api/core';

/** The agent's desktop API, as `GET /status` answers it (apps/agent/go/desktop.go). */
export interface AgentStatus {
  paused: boolean;
  connection: string;
  checkin: { checkedAt: string; lastSuccess: string; error: string };
  server: string;
  hostname: string;
  agentVersion: string;
  engine: EngineState;
  tasks: AgentTask[];
  queue: { running: string[]; pending: string[] } | null;
  queueError: string;
  observedAt: string;
}

export interface EngineState {
  installed: boolean;
  running: boolean;
  path: string | null;
  version: string | null;
  commit: string | null;
  port: number;
  diskFree: number | null;
  diskTotal: number | null;
  memoryMode: string;
  vaeOnGpu: boolean;
}

export interface AgentTask {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  bytesReceived: number;
  bytesTotal: number;
  error: string | null;
}

export interface AgentLogs {
  engine: string[];
  agent: string[];
}

/** Every call goes through the tray process, which holds the token and allows only these. */
type Path =
  | 'GET /status'
  | 'GET /logs'
  | 'POST /pause'
  | 'POST /resume'
  | 'POST /engine/start'
  | 'POST /engine/stop'
  | 'POST /engine/restart'
  | 'POST /quit';

export function call<T = unknown>(route: Path): Promise<T> {
  const [method, path] = route.split(' ');
  if (!('__TAURI_INTERNALS__' in window)) return preview(route) as Promise<T>;
  return invoke<T>('agent', { method, path });
}

// ---------------------------------------------------------------- preview
//
// Outside Tauri (`npm run dev` in a browser) there is no agent to ask, so the
// panel answers itself with a plausible machine. This is for working on the
// design without a Windows box; it is never reached in the built tray.

const sample: AgentStatus = {
  paused: false,
  connection: 'Connected',
  checkin: { checkedAt: new Date().toISOString(), lastSuccess: new Date().toISOString(), error: '' },
  server: 'https://dev.rippel.app',
  hostname: 'steve-pc',
  agentVersion: '0.4.2',
  engine: {
    installed: true,
    running: true,
    path: 'C:\\Users\\steve\\rippel\\ComfyUI',
    version: '0.3.44',
    commit: 'a1b2c3d4e5f6',
    port: 8188,
    diskFree: 412 * 1024 ** 3,
    diskTotal: 931 * 1024 ** 3,
    memoryMode: 'balanced',
    vaeOnGpu: true,
  },
  tasks: [
    {
      id: 't1',
      kind: 'update-comfy',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      bytesReceived: 0,
      bytesTotal: 0,
      error: null,
    },
  ],
  queue: { running: ['job-1'], pending: ['job-2', 'job-3'] },
  queueError: '',
  observedAt: new Date().toISOString(),
};

async function preview(route: Path): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, route.startsWith('POST') ? 600 : 80));
  switch (route) {
    case 'POST /pause':
    case 'POST /resume':
      sample.paused = route === 'POST /pause';
      return { ok: true };
    case 'POST /engine/stop':
      sample.engine.running = false;
      sample.queue = { running: [], pending: [] };
      return {};
    case 'POST /engine/start':
    case 'POST /engine/restart':
      sample.engine.running = true;
      return {};
    case 'POST /quit':
      throw 'Wait for maintenance tasks to finish before quitting.';
    case 'GET /logs':
      return {
        engine: ['Starting server', '', 'To see the GUI go to: http://127.0.0.1:8188', 'got prompt', 'Prompt executed in 4.21 seconds'],
        agent: ['rippel agent 0.4.2 listening on 0.0.0.0:8189', 'checked in with https://dev.rippel.app'],
      };
    default:
      return { ...sample, observedAt: new Date().toISOString() };
  }
}
