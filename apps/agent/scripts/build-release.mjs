#!/usr/bin/env node
/**
 * Build the agent, one file per platform.
 *
 * This used to be a packaging script: it downloaded an official Node runtime,
 * verified it against nodejs.org's SHASUMS256.txt, and zipped it up beside the
 * agent's `.mjs` source. The agent is now a Go program, so there is no runtime
 * to ship and no archive to build — `go build` with GOOS and GOARCH set
 * produces one static binary per target, and that binary *is* the release
 * asset. Nothing to unpack, nothing to compile on the target, no Node.
 *
 * Cross-compiling needs no C toolchain because the agent imports nothing that
 * needs cgo: the Windows-only calls go through syscall.NewLazyDLL, which is
 * pure Go. CGO_ENABLED=0 is set anyway, so a machine that happens to have a
 * C compiler cannot quietly produce a dynamically-linked binary that then fails
 * on a box with a different glibc.
 *
 *   node scripts/build-release.mjs
 *   node scripts/build-release.mjs --only windows
 *   node scripts/build-release.mjs --go /path/to/go
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(here, '..');
const goDir = join(agentDir, 'go');
const distDir = join(agentDir, 'dist');

/**
 * The four assets, and their names.
 *
 * The names are the contract with `apps/api/src/deploy/releases.ts` and with
 * whatever cuts the GitHub release, so they are spelled out here rather than
 * derived: `macos` rather than `darwin`, because the person downloading it
 * calls their computer a Mac.
 */
const TARGETS = [
  { name: 'rippel-agent-windows-amd64.exe', goos: 'windows', goarch: 'amd64', label: 'Windows' },
  { name: 'rippel-agent-macos-arm64', goos: 'darwin', goarch: 'arm64', label: 'macOS (Apple silicon)' },
  { name: 'rippel-agent-macos-amd64', goos: 'darwin', goarch: 'amd64', label: 'macOS (Intel)' },
  { name: 'rippel-agent-linux-amd64', goos: 'linux', goarch: 'amd64', label: 'Linux' },
];

function parseArgs(argv) {
  const options = { only: null, go: process.env.GO ?? 'go' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') options.only = argv[++i];
    else if (argv[i] === '--go') options.go = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return options;
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The version the binaries report, read from the Go source so there is one
 * place it is written down. A mismatch between what a release is called and
 * what the agent tells rippel is a support question nobody can answer.
 */
function agentVersion() {
  const source = readFileSync(join(goDir, 'config.go'), 'utf8');
  const match = source.match(/AgentVersion\s*=\s*"([^"]+)"/);
  if (!match) throw new Error('Could not find AgentVersion in go/config.go.');
  return match[1];
}

function build({ name, goos, goarch }, go) {
  const out = join(distDir, name);
  const result = spawnSync(
    go,
    [
      'build',
      // -s -w drop the symbol table and DWARF debug info. Nothing debugs these
      // binaries with a debugger — a failure on a user's machine comes back as
      // the agent's own log — and it is roughly a third of the file size.
      goos === 'windows' ? '-ldflags=-s -w -H=windowsgui' : '-ldflags=-s -w',
      // Reproducible-ish: keep the build machine's paths out of the binary.
      '-trimpath',
      '-o',
      out,
      '.',
    ],
    {
      cwd: goDir,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
    },
  );
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        `Could not run "${go}". Install Go from https://go.dev/dl/ (or pass --go /path/to/go).`,
      );
    }
    throw result.error;
  }
  if (result.status !== 0) throw new Error(`go build failed for ${goos}/${goarch}.`);
  return statSync(out).size;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const targets = options.only
    ? TARGETS.filter((t) => t.name.includes(options.only) || t.goos === options.only)
    : TARGETS;

  if (targets.length === 0) {
    console.error(`Nothing matches --only ${options.only}. Known targets:`);
    for (const t of TARGETS) console.error(`  ${t.goos}  ${t.name}`);
    process.exit(2);
  }

  // A stale asset in dist/ is worse than none: it gets uploaded to a release
  // and installed on somebody's machine.
  if (!options.only) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const version = agentVersion();
  console.log(`rippel agent ${version}\n`);

  const built = [];
  for (const target of targets) {
    process.stdout.write(`  ${target.label.padEnd(24)} `);
    const size = build(target, options.go);
    built.push({ ...target, size });
    console.log(`${target.name}  ${megabytes(size)}`);
  }

  console.log(`\nWrote ${built.length} file${built.length === 1 ? '' : 's'} to ${distDir}`);
  console.log('Each one is the whole agent. There is nothing else to ship beside it.');
}

try {
  main();
} catch (cause) {
  console.error(`\n${cause.message}`);
  process.exit(1);
}

export { TARGETS };
