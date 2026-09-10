/**
 * The two bodies of code rippel hands to a remote machine: the agent itself,
 * and the ComfyUI storage helper.
 *
 * Both are read from this repository at request time rather than fetched from
 * a release, and that is the important decision. An agent installed from
 * GitHub's "latest" is whatever was latest when the machine was set up; an
 * agent installed from the rippel that will drive it is, by construction, the
 * matching pair. Version skew between a helper and the rippel calling it is
 * precisely the failure the storage panel spends its error states explaining,
 * and this removes it.
 *
 * The GitHub release links in the UI are for the other case — a machine that
 * cannot reach this rippel yet, or an operator who wants to read the code
 * before running it.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Find a directory that ships beside the code in dev and inside the image in
 * production. `dist/` is one level flatter than `src/`, and the Dockerfile
 * copies these next to it, so both shapes are tried rather than guessed at.
 */
async function locate(candidates: string[], mustContain: string): Promise<string> {
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate);
      if (entries.includes(mustContain)) return candidate;
    } catch {
      // Not this one.
    }
  }
  throw new Error(
    `Could not find ${mustContain}. Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}`,
  );
}

export interface SourceFile {
  name: string;
  content: string;
}

async function readDir(dir: string, extensions: string[]): Promise<SourceFile[]> {
  const names = (await readdir(dir))
    .filter((name) => extensions.some((ext) => name.endsWith(ext)))
    .sort();
  return Promise.all(
    names.map(async (name) => ({ name, content: await readFile(join(dir, name), 'utf8') })),
  );
}

let helperDir: Promise<string> | null = null;
let agentDir: Promise<string> | null = null;

/** `tools/comfyui-rippel-storage`, wherever it landed. */
export function helperSourceDir(): Promise<string> {
  helperDir ??= locate(
    [
      resolve(here, '..', 'helper-source'),
      resolve(here, '..', '..', '..', '..', 'tools', 'comfyui-rippel-storage'),
    ],
    '__init__.py',
  );
  return helperDir;
}

/** `apps/agent/src`, wherever it landed. */
export function agentSourceDir(): Promise<string> {
  agentDir ??= locate(
    [
      // In the image the Dockerfile copies it beside dist/.
      resolve(here, '..', 'agent-source'),
      // In a checkout, `src/deploy` and `dist/deploy` are the same depth below
      // `apps/`, so one candidate covers both tsx and a local `node dist`.
      resolve(here, '..', '..', '..', 'agent', 'src'),
    ],
    'main.mjs',
  );
  return agentDir;
}

/** The helper's Python files, ready to POST to an agent. */
export async function helperFiles(): Promise<SourceFile[]> {
  return readDir(await helperSourceDir(), ['.py']);
}

/** The agent's modules, in the order they should be written. */
export async function agentFiles(): Promise<SourceFile[]> {
  return readDir(await agentSourceDir(), ['.mjs']);
}

/**
 * One agent file by name, for the install scripts, which fetch them one at a
 * time rather than carrying an archive format into bash and PowerShell.
 *
 * The name is matched against the real listing instead of being joined onto a
 * path, so nothing a request can say reaches the filesystem as a path at all.
 */
export async function agentFile(name: string): Promise<SourceFile | null> {
  return (await agentFiles()).find((file) => file.name === name) ?? null;
}
