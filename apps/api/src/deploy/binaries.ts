/**
 * The agent binaries this rippel can hand out.
 *
 * There is one build per platform and it is the same file for everybody. It used
 * to be otherwise: rippel served a *per-deployment* executable whose filename
 * carried the server address and the token, so that double-clicking it was the
 * whole install. That bought one click and cost too much — every rippel had to
 * serve its own build, the names were unreadable
 * (`rippel-agent-setup-eyJzIjoiaHR0cHM6...exe`), and anything that renamed the
 * download broke the install silently.
 *
 * A machine is paired now by someone typing a URL and an eight-character code
 * (see `pairing.ts`), which a browser cannot corrupt. So this module has one job
 * left: find the file and stream it. The download carries no credentials and is
 * therefore a plain static asset, cacheable and identical for every caller.
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
 * owner's failed installs were on.
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

/**
 * Where this rippel serves a given build from.
 *
 * One path per platform, no deployment in it and no token on it, because the
 * file is the same for every machine. That is what lets it be cached, mirrored,
 * or fetched once and copied onto a box with no route to this rippel at all.
 */
export function binaryDownloadPath(target: string): string {
  return `/api/deployments/agent/${target}`;
}
