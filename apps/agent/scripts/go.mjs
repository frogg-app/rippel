#!/usr/bin/env node
/**
 * Run `go` in the agent's module, from anywhere.
 *
 * This exists only so `npm test -w @comfy/agent` works the same as every other
 * workspace in this repository. The agent is a Go program, so its tests are
 * `go test` — but nobody should have to remember to cd into `apps/agent/go`
 * first, and the CI that runs `npm test --workspaces` cannot.
 *
 * It fails with a sentence rather than a stack trace when Go is not installed,
 * because that is the one thing that will actually go wrong here.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const goDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'go');
const go = process.env.GO ?? 'go';

const result = spawnSync(go, process.argv.slice(2), { cwd: goDir, stdio: 'inherit' });

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error(
      `Could not run "${go}".\n\n` +
        'The agent is a Go program. Install Go from https://go.dev/dl/ — it needs no\n' +
        'C compiler and no other setup — or point GO at a toolchain you already have:\n\n' +
        '    GO=/opt/go/bin/go npm test -w @comfy/agent\n',
    );
    process.exit(1);
  }
  throw result.error;
}
process.exit(result.status ?? 1);
