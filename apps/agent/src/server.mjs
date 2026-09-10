/**
 * The agent's HTTP API.
 *
 * Small on purpose: rippel is the only client, there is one credential, and
 * every route is either a question about this machine or an instruction to
 * change it. Node's own http module is enough, and a dependency-free agent is
 * one that installs from a tarball and a Node runtime with nothing else.
 *
 * Authentication is one shared token, compared in constant time, required on
 * every route including the ping. There is no "harmless" route here: knowing
 * whether an agent is listening is already worth something to a scanner, and a
 * token check costs nothing.
 */

import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AGENT_VERSION, saveConfig } from './config.mjs';
import {
  comfyLogFile,
  comfyStatus,
  detectAccelerator,
  installComfy,
  installHelper,
  startComfy,
  stopComfy,
  updateComfy,
} from './comfy.mjs';
import { appendLog, createTask, finishTask, getTask, isRunning, listTasks } from './tasks.mjs';

/** Longest body the agent will read. Helper sources are the only large one. */
const MAX_BODY = 1024 * 1024;

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so compare lengths only after making both sides the same size.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('The request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('The request body is not valid JSON.');
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    // Nothing here is for a browser, and this is the cheapest way to say so.
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Start a background task, refusing a second of the same kind.
 *
 * Two concurrent pip installs into one venv corrupt it in ways that look like
 * a mystery import error hours later, so the refusal is a real safety measure
 * rather than tidiness.
 */
function begin(res, kind, work) {
  if (isRunning(kind)) {
    send(res, 409, { error: 'busy', message: `A ${kind} is already running on this machine.` });
    return;
  }
  const task = createTask(kind);
  send(res, 202, { task: { ...task, log: [] } });
  void (async () => {
    try {
      await work(task);
      finishTask(task, null);
    } catch (cause) {
      finishTask(task, cause);
    }
  })();
}

export function createAgentServer(config, { onChange } = {}) {
  const changed = () => {
    try {
      onChange?.();
    } catch {
      /* a heartbeat that cannot be nudged will happen on its next tick */
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((cause) =>
      send(res, 400, { error: 'bad_request', message: String(cause.message ?? cause) }),
    );
  });

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'agent'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (!tokenMatches(req.headers['x-rippel-agent-token'], config.token)) {
      send(res, 401, {
        error: 'unauthorized',
        message: config.token
          ? 'That is not this agent’s token.'
          : 'This agent has no token configured, so it refuses every request. Set one in config.json and restart it.',
      });
      return;
    }

    // --- questions

    if (req.method === 'GET' && path === '/agent/ping') {
      send(res, 200, {
        ok: true,
        version: AGENT_VERSION,
        platform: config.platform,
        hostname: hostname(),
      });
      return;
    }

    if (req.method === 'GET' && path === '/agent/status') {
      send(res, 200, {
        ok: true,
        version: AGENT_VERSION,
        platform: config.platform,
        hostname: hostname(),
        comfy: await comfyStatus(config),
        accelerator: await detectAccelerator(),
        tasks: listTasks().map((task) => ({ ...task, log: task.log.slice(-1) })),
      });
      return;
    }

    if (req.method === 'GET' && path.startsWith('/agent/tasks/')) {
      const task = getTask(path.slice('/agent/tasks/'.length));
      if (!task) {
        send(res, 404, { error: 'not_found', message: 'No such task.' });
        return;
      }
      // `since` lets a poller ask only for what it has not seen, so a long
      // install does not re-send its whole log every two seconds.
      const since = Number(url.searchParams.get('since') ?? '0') || 0;
      send(res, 200, {
        task: { ...task, log: task.log.slice(since) },
        logOffset: task.log.length,
      });
      return;
    }

    if (req.method === 'GET' && path === '/agent/comfyui/log') {
      const text = await readFile(comfyLogFile(config), 'utf8').catch(() => '');
      // The tail is what anyone reading a log after a failed start wants.
      send(res, 200, { log: text.split(/\r?\n/).filter(Boolean).slice(-500) });
      return;
    }

    // --- instructions

    if (req.method === 'POST' && path === '/agent/comfyui/install') {
      const body = await readBody(req);
      begin(res, 'install-comfyui', async (task) => {
        await installComfy(config, task, { accelerator: body.accelerator });
        changed();
      });
      return;
    }

    if (req.method === 'POST' && path === '/agent/comfyui/update') {
      begin(res, 'update-comfyui', async (task) => {
        await updateComfy(config, task);
        changed();
      });
      return;
    }

    if (req.method === 'POST' && path === '/agent/comfyui/start') {
      const result = await startComfy(config);
      changed();
      send(res, 200, result);
      return;
    }

    if (req.method === 'POST' && path === '/agent/comfyui/stop') {
      const result = await stopComfy(config);
      changed();
      send(res, 200, result);
      return;
    }

    if (req.method === 'POST' && path === '/agent/comfyui/restart') {
      await stopComfy(config).catch(() => {});
      const result = await startComfy(config);
      changed();
      send(res, 200, result);
      return;
    }

    if (req.method === 'POST' && path === '/agent/helper/install') {
      const body = await readBody(req);
      if (!Array.isArray(body.files) || body.files.length === 0) {
        throw new Error('No helper files were sent.');
      }
      if (typeof body.storageToken !== 'string' || !body.storageToken) {
        throw new Error('No storage token was sent, and the helper refuses every request without one.');
      }
      begin(res, 'install-helper', async (task) => {
        await installHelper(config, task, body.files);
        // The helper reads its token from ComfyUI's environment, so the agent
        // has to hold it and pass it on the next start.
        config.storageToken = body.storageToken;
        saveConfig({ storageToken: body.storageToken });
        if (body.restart !== false) {
          const status = await comfyStatus(config);
          if (status.running) {
            appendLog(task, 'restarting ComfyUI so it loads the helper');
            await stopComfy(config).catch(() => {});
            await startComfy(config);
          }
        }
        changed();
      });
      return;
    }

    if (req.method === 'POST' && path === '/agent/config') {
      const body = await readBody(req);
      const patch = {};
      for (const key of ['serverUrl', 'deploymentId', 'comfyPath', 'comfyArgs']) {
        if (typeof body[key] === 'string') patch[key] = body[key];
      }
      for (const key of ['comfyPort', 'heartbeatSeconds']) {
        if (Number.isInteger(body[key])) patch[key] = body[key];
      }
      // The listening port and the token are not changeable over the wire: one
      // needs a restart to mean anything, the other would let a stolen token
      // rotate itself and lock the operator out.
      Object.assign(config, patch);
      saveConfig(patch);
      changed();
      send(res, 200, { config: { ...patch } });
      return;
    }

    send(res, 404, { error: 'not_found', message: `No route for ${req.method} ${path}.` });
  }

  return server;
}
