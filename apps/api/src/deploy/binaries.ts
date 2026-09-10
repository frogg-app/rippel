/**
 * The agent binaries this rippel can hand out, and how a download carries its
 * own credentials.
 *
 * The agent used to be a folder of `.mjs` files that an install script fetched
 * one at a time, plus an 89 MB Node runtime to run them with. It is now a
 * single static Go binary per platform, so there is nothing to assemble: this
 * module finds the file, names it, and streams it.
 *
 * The naming is the interesting part. rippel already knows the deployment's
 * server address and token at the moment someone clicks Download, so it puts
 * them *in the filename* — `rippel-agent-setup-<blob>.exe`. The agent reads its
 * own name on startup and needs nothing else, which turns "download, unzip,
 * open a terminal, paste a command" into "download, double-click". If a browser
 * or a tidy user renames the file, the agent falls back to asking, so the trick
 * can only help; it can never be the reason an install fails.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentPlatform } from '@comfy/shared';

const here = dirname(fileURLToPath(import.meta.url));

export interface AgentBinary {
  /** The stable id used in URLs and in the release assets. */
  target: string;
  /** The asset's filename, as built and as published to a GitHub release. */
  asset: string;
  platform: AgentPlatform;
  arch: 'amd64' | 'arm64';
  /** How to say it to somebody choosing a download. */
  label: string;
}

/**
 * Every binary the build script produces, in the order a download page should
 * offer them.
 *
 * Windows first because that is the machine with the GPU in it, and the one the
 * owner's two failed installs were on.
 */
export const AGENT_BINARIES: AgentBinary[] = [
  {
    target: 'windows-amd64',
    asset: 'rippel-agent-windows-amd64.exe',
    platform: 'win32',
    arch: 'amd64',
    label: 'Windows',
  },
  {
    target: 'macos-arm64',
    asset: 'rippel-agent-macos-arm64',
    platform: 'darwin',
    arch: 'arm64',
    label: 'macOS (Apple silicon)',
  },
  {
    target: 'macos-amd64',
    asset: 'rippel-agent-macos-amd64',
    platform: 'darwin',
    arch: 'amd64',
    label: 'macOS (Intel)',
  },
  {
    target: 'linux-amd64',
    asset: 'rippel-agent-linux-amd64',
    platform: 'linux',
    arch: 'amd64',
    label: 'Linux',
  },
];

export function binaryFor(target: string): AgentBinary | null {
  return AGENT_BINARIES.find((b) => b.target === target) ?? null;
}

/** The default download for a platform, when only the platform is known. */
export function defaultBinaryFor(platform: AgentPlatform): AgentBinary {
  // Apple silicon for an unqualified "macOS": it is most Macs sold since 2020,
  // and an Intel Mac owner has the second link right beside it.
  return AGENT_BINARIES.find((b) => b.platform === platform) ?? AGENT_BINARIES[0]!;
}

/**
 * Where the built binaries are.
 *
 * `apps/agent/dist` in a checkout, and copied next to the compiled server in
 * the image — the same two-shapes problem `sources.ts` solves for the helper,
 * solved the same way so there is one thing to remember.
 */
let binaryDir: Promise<string | null> | null = null;

async function locate(): Promise<string | null> {
  const candidates = [
    // In the image, beside dist/.
    resolve(here, '..', 'agent-bin'),
    // In a checkout: src/deploy and dist/deploy are the same depth below apps/.
    resolve(here, '..', '..', '..', 'agent', 'dist'),
  ];
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate);
      if (entries.some((name) => name.startsWith('rippel-agent-'))) return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

export function agentBinaryDir(): Promise<string | null> {
  binaryDir ??= locate();
  return binaryDir;
}

/** Test seam: forget where the binaries were. */
export function clearBinaryCache(): void {
  binaryDir = null;
}

export interface FoundBinary extends AgentBinary {
  path: string;
  sizeBytes: number;
}

/**
 * The binaries that actually exist on this rippel's disk right now.
 *
 * Absent is a normal state, not an error: a rippel installed from a released
 * image has them, a rippel run from a checkout has them only after
 * `npm run build:release -w @comfy/agent`. The Deployment screen says which of
 * those it is looking at rather than offering a link that 404s.
 */
export async function availableBinaries(): Promise<FoundBinary[]> {
  const dir = await agentBinaryDir();
  if (!dir) return [];

  const found: FoundBinary[] = [];
  for (const binary of AGENT_BINARIES) {
    const path = join(dir, binary.asset);
    try {
      const info = await stat(path);
      if (info.isFile()) found.push({ ...binary, path, sizeBytes: info.size });
    } catch {
      // Not built for that platform.
    }
  }
  return found;
}

export async function findBinary(target: string): Promise<FoundBinary | null> {
  return (await availableBinaries()).find((b) => b.target === target) ?? null;
}

/** A stream of one binary's bytes, for a route to pipe at a browser. */
export function readBinary(binary: FoundBinary): NodeJS.ReadableStream {
  return createReadStream(binary.path);
}

// ---------------------------------------------------------------- setup codes

export interface SetupDetails {
  /** Where the agent checks in, e.g. http://192.168.1.9:4000 — no trailing slash. */
  serverUrl: string;
  token: string;
  /** Only sent when they differ from the agent's own defaults. */
  agentPort?: number;
  comfyPort?: number;
}

/**
 * Pack a setup into the base64url blob that goes in a filename.
 *
 * This must stay byte-for-byte compatible with `DecodeSetup` in
 * `apps/agent/go/setup.go` — the short keys are deliberate, because the blob
 * ends up in a filename and Windows still has a path length limit.
 *
 * base64url's alphabet (A–Z a–z 0–9 - _) is exactly what is safe in a filename
 * on all three platforms, which is why it is the encoding rather than anything
 * with padding or punctuation in it.
 */
export function encodeSetup(setup: SetupDetails): string {
  const payload: Record<string, string | number> = {
    s: setup.serverUrl.replace(/\/+$/, ''),
    t: setup.token,
  };
  // Omitted when they are the agent's defaults, because every byte here is a
  // byte of filename.
  if (setup.agentPort && setup.agentPort !== 8189) payload.p = setup.agentPort;
  if (setup.comfyPort && setup.comfyPort !== 8188) payload.c = setup.comfyPort;
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * The filename a download is served under, carrying its own setup.
 *
 * The `.exe` matters on Windows and must survive: without it the file will not
 * run at all, so the extension is appended after the blob rather than being
 * part of it.
 */
export function downloadFileName(binary: AgentBinary, setup: SetupDetails): string {
  const suffix = binary.platform === 'win32' ? '.exe' : '';
  return `rippel-agent-setup-${encodeSetup(setup)}${suffix}`;
}

/**
 * The link rippel shows for pasting, and the page a person opens to download.
 *
 * It carries the token in the path rather than a query string because it is
 * meant to be copied by hand: a path segment survives a chat window, an email
 * client and a screenshot in a way `?token=` does not.
 */
export function setupLink(serverUrl: string, token: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/api/deployments/setup/${encodeURIComponent(token)}`;
}
