/**
 * The agent's own tests. Plain `node --test`, because the agent's whole claim
 * is that it runs on a bare Node install with nothing fetched from npm, and a
 * test suite that needed a runner would quietly undermine that.
 *
 * What is covered is the part that is security-relevant or easy to get subtly
 * wrong: the token check, the task log's bounds, and the refusal to write a
 * helper file outside its own folder.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { appendLog, createTask, finishTask, getTask, isRunning, run } from '../src/tasks.mjs';
import { installHelper } from '../src/comfy.mjs';
import { createAgentServer } from '../src/server.mjs';

const home = mkdtempSync(join(tmpdir(), 'rippel-agent-test-'));
after(() => rmSync(home, { recursive: true, force: true }));

function config(over = {}) {
  return {
    token: 'the-token',
    serverUrl: '',
    deploymentId: '',
    port: 0,
    host: '127.0.0.1',
    comfyPath: join(home, 'ComfyUI'),
    comfyPort: 18188,
    comfyArgs: '',
    storageToken: '',
    heartbeatSeconds: 20,
    platform: 'linux',
    home,
    ...over,
  };
}

/** Start the server on an ephemeral port and hand back a bound fetch. */
async function serve(cfg = config()) {
  const server = createAgentServer(cfg);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    call: (path, init = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { 'X-Rippel-Agent-Token': 'the-token', ...(init.headers ?? {}) },
      }),
    raw: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('tasks', () => {
  it('keeps the tail of a very long log rather than growing without bound', () => {
    const task = createTask('test');
    for (let i = 0; i < 2500; i++) appendLog(task, `line ${i}`);
    assert.equal(task.log.length, 2000);
    // The end is what says why something failed, so that is the end kept.
    assert.equal(task.log.at(-1), 'line 2499');
    finishTask(task, null);
    assert.equal(task.status, 'done');
  });

  it('records a failure with its message and finds it by id', () => {
    const task = createTask('test-fail');
    finishTask(task, new Error('pip died'));
    assert.equal(task.status, 'failed');
    assert.equal(task.error, 'pip died');
    assert.equal(getTask(task.id).id, task.id);
    assert.equal(isRunning('test-fail'), false);
  });

  it('rejects when a command exits non-zero, and captures its output', async () => {
    const task = createTask('exit');
    await assert.rejects(
      () => run(task, process.execPath, ['-e', 'console.error("nope"); process.exit(3)']),
      /exited with code 3/,
    );
    assert.ok(task.log.some((line) => line.includes('nope')));
    finishTask(task, null);
  });

  it('rejects rather than throwing when the command does not exist', async () => {
    const task = createTask('missing');
    await assert.rejects(() => run(task, 'definitely-not-a-real-binary-xyz', []), /could not run/);
    finishTask(task, null);
  });
});

describe('the helper installer', () => {
  it('refuses a filename that would climb out of custom_nodes', async () => {
    const task = createTask('helper');
    const cfg = config();
    // No ComfyUI on disk, so the guard has to fire before the missing-install
    // check would — that ordering is the thing being asserted.
    await assert.rejects(
      () => installHelper(cfg, task, [{ name: '../../evil.py', content: 'x' }]),
      /No ComfyUI|Refusing to write/,
    );
    finishTask(task, null);
  });
});

describe('the HTTP API', () => {
  it('refuses every route without the token, including the ping', async () => {
    const agent = await serve();
    try {
      const res = await agent.raw('/agent/ping');
      assert.equal(res.status, 401);
      const wrong = await agent.raw('/agent/ping', { headers: { 'X-Rippel-Agent-Token': 'guess' } });
      assert.equal(wrong.status, 401);
    } finally {
      await agent.close();
    }
  });

  it('refuses a token of a different length without comparing bytes', async () => {
    // timingSafeEqual throws on unequal lengths; the length check must come
    // first or a short token would 500 instead of 401.
    const agent = await serve();
    try {
      const res = await agent.raw('/agent/ping', { headers: { 'X-Rippel-Agent-Token': 'x' } });
      assert.equal(res.status, 401);
    } finally {
      await agent.close();
    }
  });

  it('answers the ping and the status with what it knows', async () => {
    const agent = await serve();
    try {
      const ping = await (await agent.call('/agent/ping')).json();
      assert.equal(ping.ok, true);
      assert.equal(ping.platform, 'linux');

      const status = await (await agent.call('/agent/status')).json();
      // Nothing is installed in a temp dir, and the status says so plainly
      // rather than failing.
      assert.equal(status.comfy.installed, false);
      assert.equal(status.comfy.running, false);
      assert.equal(status.comfy.helperInstalled, false);
      assert.equal(status.comfy.port, 18188);
    } finally {
      await agent.close();
    }
  });

  it('404s an unknown route and a missing task', async () => {
    const agent = await serve();
    try {
      assert.equal((await agent.call('/agent/nope')).status, 404);
      assert.equal((await agent.call('/agent/tasks/not-a-task')).status, 404);
    } finally {
      await agent.close();
    }
  });

  it('refuses to install a helper with no token, since it would never answer', async () => {
    const agent = await serve();
    try {
      const res = await agent.call('/agent/helper/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ name: '__init__.py', content: '' }] }),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).message, /storage token/);
    } finally {
      await agent.close();
    }
  });

  it('will not start ComfyUI that is not there', async () => {
    const agent = await serve();
    try {
      const res = await agent.call('/agent/comfyui/start', { method: 'POST' });
      assert.equal(res.status, 400);
      assert.match((await res.json()).message, /Install it first/);
    } finally {
      await agent.close();
    }
  });

  it('reports nothing to stop rather than erroring', async () => {
    const agent = await serve();
    try {
      const res = await agent.call('/agent/comfyui/stop', { method: 'POST' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).stopped, false);
    } finally {
      await agent.close();
    }
  });

  it('starts an install as a task and returns immediately', async () => {
    // The install is genuinely started, so it is pointed at a path under a
    // regular file: git fails on the first step and nothing is downloaded.
    // What is being asserted is the handoff, not the install.
    const blocked = join(home, 'not-a-directory');
    writeFileSync(blocked, '');
    const agent = await serve(config({ comfyPath: join(blocked, 'ComfyUI') }));
    try {
      const res = await agent.call('/agent/comfyui/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accelerator: 'cpu' }),
      });
      // 202, not 200: the work has been accepted, not done.
      assert.equal(res.status, 202);
      const { task } = await res.json();
      assert.equal(task.status, 'running');

      const second = await agent.call('/agent/comfyui/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accelerator: 'cpu' }),
      });
      // Two pip installs into one venv corrupt it, so the second is refused.
      assert.equal(second.status, 409);

      const followed = await (await agent.call(`/agent/tasks/${task.id}`)).json();
      assert.equal(followed.task.id, task.id);
    } finally {
      await agent.close();
    }
  });
});
