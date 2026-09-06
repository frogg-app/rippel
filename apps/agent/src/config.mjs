/**
 * Where the agent's settings come from, and where its state lives.
 *
 * Every setting has an environment variable and a place in `config.json` next
 * to the install, with the environment winning. That split is not decoration:
 * the install scripts write config.json (so a service unit needs no env block
 * and a token never lands in a shell history), while a person debugging by
 * hand overrides one value on the command line without editing a file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_VERSION = '0.1.0';

const here = dirname(fileURLToPath(import.meta.url));

/** `~/.rippel-agent` unless RIPPEL_AGENT_HOME says otherwise. */
export function agentHome() {
  return resolve(process.env.RIPPEL_AGENT_HOME || join(homedir(), '.rippel-agent'));
}

/**
 * The config, and the directory it came from.
 *
 * Where it came from matters as much as what is in it. The installer puts the
 * agent wherever RIPPEL_AGENT_HOME said at install time, and the service unit it
 * writes carries no environment — so a later run finds the file beside the
 * source rather than at the default home. Everything the agent writes (the pid
 * file, ComfyUI's log, an updated config) has to land next to that file, not at
 * a path nothing is in.
 */
function readFile() {
  // The file sits in the agent home, but an install run in place keeps one
  // beside the source too, so both are looked at, home first.
  for (const path of [join(agentHome(), 'config.json'), resolve(here, '..', 'config.json')]) {
    if (!existsSync(path)) continue;
    try {
      return { values: JSON.parse(readFileSync(path, 'utf8')), dir: dirname(path) };
    } catch (cause) {
      throw new Error(`${path} is not valid JSON: ${cause.message}`);
    }
  }
  return { values: {}, dir: agentHome() };
}

function normalisePlatform() {
  const p = platform();
  return p === 'linux' || p === 'darwin' || p === 'win32' ? p : 'unknown';
}

export function loadConfig() {
  const { values: file, dir: home } = readFile();
  const pick = (envName, key, fallback) => {
    const fromEnv = process.env[envName];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    if (file[key] !== undefined && file[key] !== null && file[key] !== '') return String(file[key]);
    return fallback;
  };

  const config = {
    /** Shared secret. Every request to this agent must carry it. */
    token: pick('RIPPEL_AGENT_TOKEN', 'token', ''),
    /** The rippel API, e.g. http://192.168.1.9:4000. Empty disables check-in. */
    serverUrl: pick('RIPPEL_SERVER_URL', 'serverUrl', '').replace(/\/+$/, ''),
    /** The deployment row this agent belongs to, when the server made one. */
    deploymentId: pick('RIPPEL_DEPLOYMENT_ID', 'deploymentId', ''),
    /** Where this agent listens. */
    port: Number(pick('RIPPEL_AGENT_PORT', 'port', '8189')),
    host: pick('RIPPEL_AGENT_HOST', 'host', '0.0.0.0'),
    /** Where ComfyUI is (or will be) installed. */
    comfyPath: resolve(pick('RIPPEL_COMFY_PATH', 'comfyPath', join(home, 'ComfyUI'))),
    /** The port the agent starts ComfyUI on. */
    comfyPort: Number(pick('RIPPEL_COMFY_PORT', 'comfyPort', '8188')),
    /** Extra arguments appended to ComfyUI's command line. */
    comfyArgs: pick('RIPPEL_COMFY_ARGS', 'comfyArgs', ''),
    /** The token the storage helper is installed with. */
    storageToken: pick('RIPPEL_STORAGE_TOKEN', 'storageToken', ''),
    /** Seconds between check-ins. */
    heartbeatSeconds: Number(pick('RIPPEL_HEARTBEAT_SECONDS', 'heartbeatSeconds', '20')),
    platform: normalisePlatform(),
    home,
  };

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`RIPPEL_AGENT_PORT must be a port number, got "${config.port}".`);
  }
  return config;
}

/**
 * Persist changed settings back to the config file the agent actually read,
 * creating it at the default home if there was none.
 */
export function saveConfig(patch) {
  const home = readFile().dir;
  mkdirSync(home, { recursive: true });
  const path = join(home, 'config.json');
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const next = { ...current, ...patch };
  // 0600: the file holds the token, and on a shared box the default umask is
  // not enough. Windows ignores the mode; its ACL comes from the profile dir.
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}
