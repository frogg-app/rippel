/**
 * The ComfyUI storage helper, as rippel hands it to a remote machine.
 *
 * It is read from this repository at request time rather than fetched from a
 * release, and that is the important decision. A helper installed from GitHub's
 * "latest" is whatever was latest when the machine was set up; a helper
 * installed by the rippel that will call it is, by construction, the matching
 * pair. Version skew between a helper and the rippel calling it is precisely
 * the failure the storage panel spends its error states explaining, and this
 * removes it.
 *
 * The agent used to be served from here too, as a list of `.mjs` files that an
 * install script downloaded one at a time. It is a compiled binary now, served
 * by `binaries.ts` — but the same argument still holds, which is why the
 * download comes from this rippel rather than from GitHub.
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

/** The helper's Python files, ready to POST to an agent. */
export async function helperFiles(): Promise<SourceFile[]> {
  return readDir(await helperSourceDir(), ['.py']);
}

