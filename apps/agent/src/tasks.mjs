/**
 * Long-running work, as something a poller can watch.
 *
 * Installing ComfyUI is minutes of pip output, and the request that asked for
 * it must not be held open for those minutes — an HTTP client, a reverse proxy
 * and a laptop lid all disagree about how long is too long. So a start returns
 * a task id immediately and the output accumulates here, in memory, for
 * `GET /agent/tasks/:id` to read.
 *
 * In memory is the right scope: a task that was running when the agent was
 * restarted did not survive the restart either, and a log that outlived the
 * process would claim otherwise.
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

/** Lines kept per task. Enough for a full pip install, bounded for a long one. */
const MAX_LINES = 2000;
/** Finished tasks are dropped after this long so the map cannot grow forever. */
const KEEP_FINISHED_MS = 60 * 60 * 1000;

const tasks = new Map();

export function createTask(kind) {
  const task = {
    id: randomUUID(),
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
    error: null,
  };
  tasks.set(task.id, task);
  return task;
}

export function getTask(id) {
  return tasks.get(id) ?? null;
}

export function listTasks() {
  return [...tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function appendLog(task, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    task.log.push(line);
  }
  // Keep the tail: the end of a failing install says why, the start says what.
  if (task.log.length > MAX_LINES) task.log.splice(0, task.log.length - MAX_LINES);
}

export function finishTask(task, error) {
  task.status = error ? 'failed' : 'done';
  task.error = error ? String(error.message ?? error) : null;
  task.finishedAt = new Date().toISOString();
  if (error) appendLog(task, `error: ${task.error}`);
  setTimeout(() => tasks.delete(task.id), KEEP_FINISHED_MS).unref?.();
}

/** True when a task of this kind is already running — installs must not race. */
export function isRunning(kind) {
  for (const task of tasks.values()) {
    if (task.kind === kind && task.status === 'running') return true;
  }
  return false;
}

/**
 * Run one command, streaming both streams into the task log.
 *
 * Resolves on exit code 0 and rejects otherwise, so a sequence of steps can be
 * written as plain `await`s and the first failure stops the rest. `shell` is
 * never used: every argument is passed as an array element, so a path with a
 * space in it — `C:\Program Files\...`, the common case on Windows — needs no
 * quoting and nothing in a task's input can be read as a command.
 */
export function run(task, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    appendLog(task, `$ ${command} ${args.join(' ')}`);
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      reject(cause);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => appendLog(task, chunk));
    child.stderr.on('data', (chunk) => appendLog(task, chunk));
    child.on('error', (cause) =>
      reject(new Error(`could not run ${command}: ${cause.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
