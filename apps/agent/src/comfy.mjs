/**
 * Everything the agent knows how to do to a ComfyUI install.
 *
 * The install is deliberately the boring one everybody does by hand — git
 * clone, a venv beside it, pip install torch, pip install -r requirements.txt
 * — because the failure modes of that sequence are the ones every ComfyUI
 * answer on the internet is about. An agent with a clever bespoke layout would
 * be a machine nobody else could help you fix.
 *
 * Two things are not boring and are worth stating:
 *
 *  - **Which torch.** There is no one wheel index that works on every machine,
 *    and installing the wrong one gets you a ComfyUI that starts, loads a
 *    checkpoint, and faults on the first real kernel — the same silent-wrong
 *    outcome the README describes for a misidentified device. So the vendor is
 *    detected (nvidia-smi, then rocminfo) and, failing that, the caller must
 *    say; we never guess CUDA because CUDA is the common case.
 *  - **Starting it detached.** ComfyUI must outlive the request that started it
 *    and the agent process itself, so it is spawned detached with its output
 *    redirected to a file and its pid written down. Anything else and a service
 *    restart of the agent takes the GPU down with it.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { appendLog, run } from './tasks.mjs';

const COMFY_REPO = 'https://github.com/comfyanonymous/ComfyUI.git';
/** The folder name the helper must have inside custom_nodes. */
export const HELPER_DIR = 'comfyui-rippel-storage';

const isWindows = process.platform === 'win32';

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function venvPath(config) {
  return join(config.comfyPath, '.venv');
}

/** The interpreter inside the venv, which is what every later step must use. */
export function venvPython(config) {
  return isWindows
    ? join(venvPath(config), 'Scripts', 'python.exe')
    : join(venvPath(config), 'bin', 'python');
}

function pidFile(config) {
  return join(config.home, 'comfyui.pid');
}

export function comfyLogFile(config) {
  return join(config.home, 'comfyui.log');
}

// ---------------------------------------------------------------- status

async function readPid(config) {
  try {
    const pid = Number((await readFile(pidFile(config), 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Whether that pid is still a live process. Signal 0 tests, it does not kill. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means it exists and belongs to someone else, which still counts.
    return cause.code === 'EPERM';
  }
}

async function askComfy(config, path, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${config.comfyPort}${path}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function gitCommit(config) {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: config.comfyPath,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

/** Whether the helper is present, and whether it actually answers. */
async function helperState(config) {
  const dir = join(config.comfyPath, 'custom_nodes', HELPER_DIR);
  const installed = await exists(join(dir, '__init__.py'));
  if (!installed || !config.storageToken) return { helperInstalled: installed, helperReady: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`http://127.0.0.1:${config.comfyPort}/rippel/storage/ping`, {
      headers: { 'X-Rippel-Token': config.storageToken },
      signal: controller.signal,
    });
    return { helperInstalled: true, helperReady: res.ok };
  } catch {
    return { helperInstalled: true, helperReady: false };
  } finally {
    clearTimeout(timer);
  }
}

async function disk(path) {
  try {
    const fs = await statfs(path);
    return { diskFree: fs.bsize * fs.bavail, diskTotal: fs.bsize * fs.blocks };
  } catch {
    return { diskFree: null, diskTotal: null };
  }
}

/**
 * The whole picture of the managed ComfyUI, as one object.
 *
 * "Running" is answered by asking the port, not by the pid file: a pid file
 * outlives a crash, and an operator who started ComfyUI by hand has no pid file
 * at all. The pid is only how we stop it.
 */
export async function comfyStatus(config) {
  const installed = await exists(join(config.comfyPath, 'main.py'));
  const stats = await askComfy(config, '/system_stats');
  const { helperInstalled, helperReady } = await helperState(config);
  const space = await disk(installed ? config.comfyPath : config.home);
  return {
    installed,
    running: stats !== null,
    path: installed ? config.comfyPath : null,
    version: stats?.system?.comfyui_version ?? null,
    commit: installed ? await gitCommit(config) : null,
    port: config.comfyPort,
    helperInstalled,
    helperReady,
    ...space,
  };
}

// ---------------------------------------------------------------- install

/** Which torch wheels this machine wants, asked of the machine. */
export async function detectAccelerator() {
  const probe = (command, args) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  if (await probe('nvidia-smi', ['-L'])) return 'cuda';
  if (await probe('rocminfo', [])) return 'rocm';
  return 'cpu';
}

/** The pip index for each vendor. Empty means PyPI's default, which is CUDA. */
function torchIndex(accelerator) {
  if (accelerator === 'rocm') return 'https://download.pytorch.org/whl/rocm6.2';
  if (accelerator === 'cpu') return 'https://download.pytorch.org/whl/cpu';
  return 'https://download.pytorch.org/whl/cu124';
}

async function systemPython(task) {
  for (const candidate of isWindows ? ['python', 'py'] : ['python3', 'python']) {
    const ok = await new Promise((resolve) => {
      const child = spawn(candidate, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    if (ok) {
      appendLog(task, `using ${candidate} to create the virtual environment`);
      return candidate;
    }
  }
  throw new Error(
    'No Python found on this machine. Install Python 3.10 or newer and make sure it is on PATH, then try again.',
  );
}

/**
 * Clone ComfyUI, build its venv and install its dependencies.
 *
 * Idempotent by design: an existing checkout is updated rather than refused,
 * and an existing venv is reused, so re-running after a failure part-way
 * through picks up where it stopped instead of demanding a clean machine.
 */
export async function installComfy(config, task, options = {}) {
  const accelerator =
    options.accelerator && options.accelerator !== 'auto'
      ? options.accelerator
      : await detectAccelerator();
  appendLog(task, `installing ComfyUI into ${config.comfyPath} for ${accelerator}`);

  await mkdir(config.home, { recursive: true });

  if (await exists(join(config.comfyPath, '.git'))) {
    appendLog(task, 'a checkout is already there; updating it instead of cloning');
    await run(task, 'git', ['pull', '--ff-only'], { cwd: config.comfyPath });
  } else {
    if (await exists(config.comfyPath)) {
      const entries = await stat(config.comfyPath).catch(() => null);
      if (entries?.isDirectory()) {
        appendLog(task, `${config.comfyPath} exists but is not a git checkout; cloning into it`);
      }
    }
    await run(task, 'git', ['clone', '--depth', '1', COMFY_REPO, config.comfyPath]);
  }

  if (!(await exists(venvPython(config)))) {
    const python = await systemPython(task);
    await run(task, python, ['-m', 'venv', venvPath(config)]);
  } else {
    appendLog(task, 'virtual environment already exists; reusing it');
  }

  const python = venvPython(config);
  await run(task, python, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel']);
  await run(task, python, [
    '-m',
    'pip',
    'install',
    'torch',
    'torchvision',
    'torchaudio',
    '--index-url',
    torchIndex(accelerator),
  ]);
  await run(task, python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], {
    cwd: config.comfyPath,
  });

  appendLog(task, 'ComfyUI installed.');
  return accelerator;
}

/** `git pull` plus a dependency refresh. Does not restart; the caller decides. */
export async function updateComfy(config, task) {
  if (!(await exists(join(config.comfyPath, '.git')))) {
    throw new Error(`No ComfyUI checkout at ${config.comfyPath}. Install it first.`);
  }
  await run(task, 'git', ['pull', '--ff-only'], { cwd: config.comfyPath });
  await run(task, venvPython(config), ['-m', 'pip', 'install', '-r', 'requirements.txt'], {
    cwd: config.comfyPath,
  });
  appendLog(task, 'ComfyUI updated.');
}

// ---------------------------------------------------------------- run control

/**
 * Start ComfyUI detached, listening on every interface.
 *
 * `--listen 0.0.0.0` is not optional here: the whole point of a deployment is
 * that rippel is on another machine. ComfyUI has no authentication of its own,
 * which is why the README is emphatic that it belongs on a LAN.
 */
export async function startComfy(config) {
  if (!(await exists(join(config.comfyPath, 'main.py')))) {
    throw new Error(`No ComfyUI at ${config.comfyPath}. Install it first.`);
  }
  const status = await comfyStatus(config);
  if (status.running) return { started: false, reason: 'already running' };

  await mkdir(config.home, { recursive: true });
  const log = await open(comfyLogFile(config), 'a');
  const args = [
    'main.py',
    '--listen',
    '0.0.0.0',
    '--port',
    String(config.comfyPort),
    ...config.comfyArgs.split(' ').filter(Boolean),
  ];
  const child = spawn(venvPython(config), args, {
    cwd: config.comfyPath,
    // The storage helper reads its token from ComfyUI's own environment, so it
    // has to be set on the process we start, not on the agent.
    env: config.storageToken
      ? { ...process.env, RIPPEL_STORAGE_TOKEN: config.storageToken }
      : process.env,
    detached: !isWindows,
    stdio: ['ignore', log.fd, log.fd],
    windowsHide: true,
  });
  child.unref();
  await log.close();
  await writeFile(pidFile(config), String(child.pid));
  return { started: true, pid: child.pid };
}

/**
 * Stop it, politely first.
 *
 * SIGTERM lets ComfyUI finish writing whatever it was writing; SIGKILL after a
 * grace period covers the case where it is wedged in a CUDA call and cannot.
 * On Windows there are no signals, so taskkill /T takes the tree — the venv
 * python is a child of nothing else, so the tree is exactly ComfyUI.
 */
export async function stopComfy(config, graceMs = 10_000) {
  const pid = await readPid(config);
  if (pid === null || !alive(pid)) {
    await rm(pidFile(config), { force: true });
    const status = await comfyStatus(config);
    if (status.running) {
      throw new Error(
        'ComfyUI is answering on its port but was not started by this agent, so the agent will not stop it. Stop it where it was started.',
      );
    }
    return { stopped: false, reason: 'not running' };
  }

  if (isWindows) {
    await new Promise((resolve) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      child.on('error', resolve);
      child.on('close', resolve);
    });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone between the check and here; nothing to do.
    }
    const deadline = Date.now() + graceMs;
    while (alive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* raced with its own exit */
      }
    }
  }
  await rm(pidFile(config), { force: true });
  return { stopped: true, pid };
}

// ---------------------------------------------------------------- helper node

/**
 * Put comfyui-rippel-storage into custom_nodes.
 *
 * The source comes from the rippel server rather than being carried in the
 * agent, so the helper always matches the rippel that will call it — a
 * mismatched pair is the one failure this whole panel exists to prevent, and
 * the alternative (shipping a copy inside the agent) guarantees one the first
 * time either side changes.
 *
 * The token is written into the ComfyUI launch environment rather than the
 * helper's source, because that is where the helper reads it from and because
 * a token in a file under custom_nodes would end up in whatever backup or
 * screenshot the folder does.
 */
export async function installHelper(config, task, files) {
  const dir = join(config.comfyPath, 'custom_nodes', HELPER_DIR);
  if (!(await exists(join(config.comfyPath, 'custom_nodes')))) {
    throw new Error(`No ComfyUI at ${config.comfyPath}. Install it first.`);
  }
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    // The server names these; refuse anything that would climb out of the dir.
    if (file.name.includes('..') || file.name.includes('/') || file.name.includes('\\')) {
      throw new Error(`Refusing to write a helper file named "${file.name}".`);
    }
    await writeFile(join(dir, file.name), file.content, 'utf8');
    appendLog(task, `wrote custom_nodes/${HELPER_DIR}/${file.name}`);
  }
  appendLog(task, 'Storage helper installed. ComfyUI must restart to pick it up.');
  return dir;
}

export { exists as pathExists };
