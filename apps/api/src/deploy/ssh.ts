/**
 * Managed install: rippel SSHes in and runs the same installer the manual path
 * would have pasted.
 *
 * That equivalence is the whole design. There is no second install procedure
 * here — this module opens a connection, pipes the generated script into
 * `bash -s` (or PowerShell), and streams what comes back. Anything that can go
 * wrong on the managed path can be reproduced by pasting one line, and a fix
 * to the installer fixes both.
 *
 * Credentials are never stored. A password or key lives in the request body,
 * is used to open one connection, and is gone when the run object is collected
 * — there is no column for it and nothing writes one to disk. That also means
 * a re-run needs the credential again, which is the correct trade for a tool
 * that can install software as you on your GPU box.
 */

import { randomUUID } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshInstallInput, SshRun } from '@comfy/shared';
import { env } from '../env.js';

/** Lines kept per run — enough for a full installer, bounded for a stuck one. */
const MAX_LINES = 1000;
const KEEP_FINISHED_MS = 30 * 60 * 1000;

const runs = new Map<string, SshRun>();

export function getRun(id: string): SshRun | null {
  return runs.get(id) ?? null;
}

export function listRuns(): SshRun[] {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function append(run: SshRun, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    run.log.push(line);
  }
  if (run.log.length > MAX_LINES) run.log.splice(0, run.log.length - MAX_LINES);
}

function finish(run: SshRun, error: string | null): void {
  run.status = error ? 'failed' : 'done';
  run.error = error;
  run.finishedAt = new Date().toISOString();
  if (error) append(run, `error: ${error}`);
  setTimeout(() => runs.delete(run.id), KEEP_FINISHED_MS).unref();
}

export type SshExec = (
  config: ConnectConfig,
  command: string,
  script: string,
  onOutput: (chunk: string) => void,
) => Promise<number>;

/**
 * Open a connection, run one command with `script` on its stdin, resolve with
 * the exit code.
 *
 * stdin rather than an argument because the script is thousands of characters
 * of shell and PowerShell containing quotes of both kinds; there is no safe
 * quoting of that into a command line, and there is no need for one.
 */
export const realExec: SshExec = (config, command, script, onOutput) =>
  new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      client.end();
      fn();
    };

    const timer = setTimeout(
      () => done(() => reject(new Error('The install did not finish in time and was stopped.'))),
      env.deploy.sshTimeoutMs,
    );
    timer.unref();

    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          done(() => reject(err));
          return;
        }
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => onOutput(chunk));
        stream.stderr.setEncoding('utf8');
        stream.stderr.on('data', (chunk: string) => onOutput(chunk));
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          done(() => resolve(code ?? 0));
        });
        stream.end(script);
      });
    });

    client.on('error', (cause) => {
      clearTimeout(timer);
      done(() => reject(cause));
    });

    try {
      client.connect(config);
    } catch (cause) {
      clearTimeout(timer);
      done(() => reject(cause));
    }
  });

export interface StartSshOptions {
  input: SshInstallInput;
  deploymentId: string;
  /** The installer to pipe in, already generated for this deployment. */
  script: string;
  platform: 'posix' | 'win32';
  exec?: SshExec;
}

/**
 * Turn an SSH failure into something an operator can act on.
 *
 * ssh2's own messages are accurate and unhelpful — "All configured
 * authentication methods failed" is true of a typo'd password, a key with the
 * wrong passphrase, and a server that only accepts keys.
 */
function explain(cause: unknown, input: SshInstallInput): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/authentication methods failed/i.test(message)) {
    return input.privateKey
      ? `${input.host} refused that key for ${input.username}. Check the key is in the account's authorized_keys, and that any passphrase is right.`
      : `${input.host} refused that password for ${input.username}. If the server only accepts keys, use one here instead.`;
  }
  if (/ECONNREFUSED/.test(message)) {
    return `Nothing is listening for SSH on ${input.host}:${input.port ?? 22}.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    return `Could not resolve ${input.host}. Use its IP address if this machine has no DNS for it.`;
  }
  if (/ETIMEDOUT|timed out/i.test(message)) {
    return `${input.host} did not answer on port ${input.port ?? 22}. A firewall between here and there is the usual cause.`;
  }
  if (/Cannot parse privateKey|no such (identity|key)/i.test(message)) {
    return 'That private key could not be read. Paste the whole file, including the BEGIN and END lines.';
  }
  return message;
}

/**
 * Start a managed install. Returns immediately with a run to poll.
 *
 * Nothing here waits for the install: a ComfyUI-capable machine takes minutes
 * to pip-install torch, and holding an HTTP request open for that is how a
 * reverse proxy silently truncates an install log.
 */
export function startSshInstall(options: StartSshOptions): SshRun {
  const { input, deploymentId, script, platform } = options;
  const exec = options.exec ?? realExec;

  const run: SshRun = {
    id: randomUUID(),
    deploymentId,
    host: input.host,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
    error: null,
  };
  runs.set(run.id, run);

  const config: ConnectConfig = {
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    readyTimeout: 20_000,
    ...(input.privateKey
      ? { privateKey: input.privateKey, passphrase: input.passphrase || undefined }
      : { password: input.password }),
  };

  // `sudo -S` reads the password from the same stdin the script arrives on,
  // which would consume the script itself. So sudo is only offered where it can
  // be password-less, and the UI says as much.
  const command =
    platform === 'win32'
      ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command -'
      : input.useSudo
        ? 'sudo -n bash -s'
        : 'bash -s';

  append(run, `connecting to ${input.username}@${input.host}:${config.port}`);

  void (async () => {
    try {
      const code = await exec(config, command, script, (chunk) => append(run, chunk));
      if (code === 0) {
        append(run, 'installer finished.');
        finish(run, null);
      } else {
        finish(run, `The installer exited with code ${code}. The log above says where it stopped.`);
      }
    } catch (cause) {
      finish(run, explain(cause, input));
    }
  })();

  return run;
}

/** Test seam. */
export function resetRuns(): void {
  runs.clear();
}
