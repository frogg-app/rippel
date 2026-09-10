#!/usr/bin/env node
/**
 * Build the three release assets, with a Node runtime inside each one.
 *
 * The agent is plain JavaScript, so for a long time a "release" was a folder of
 * `.mjs` files and the installer refused to continue when the target machine
 * had no Node. On a Windows GPU box — which has Python, because ComfyUI brought
 * it, and nothing else — that is the whole first experience: an error. So the
 * official Node runtime is bundled and the target needs nothing preinstalled.
 *
 * This is packaging, not compiling: we download the runtimes Node publishes,
 * check them against that release's SHASUMS256.txt, take the single `node`
 * binary out of each, and assemble folders. It therefore runs anywhere, and
 * cross-builds all three assets from one Linux box.
 *
 * What each asset carries:
 *
 *   windows  node/node.exe            win-x64
 *   macos    node/bin/node-arm64      osx-arm64  ┐ both, because Macs are
 *            node/bin/node-x64        osx-x64    ┘ genuinely still split
 *   linux    node/bin/node            linux-x64
 *
 * Linux and Windows are x64 only. A ComfyUI machine is an x64 box with a
 * discrete GPU essentially without exception, and the installer falls back to a
 * system Node on anything else rather than shipping runtimes nobody will run.
 *
 * Only the binary ships. The full distribution is npm, headers, docs and a
 * corepack shim the agent never touches.
 *
 * Usage:
 *   node apps/agent/scripts/build-release.mjs [--node vX.Y.Z] [--out DIR]
 *                                             [--only windows,macos,linux]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntry, writeZip } from './zip.mjs';

/**
 * The Node the releases carry.
 *
 * Bumping this is a shipping decision, not a detail: see "The bundled runtime"
 * in the agent README. Keep it on an active LTS line, and keep the README's
 * version table in step with it.
 */
const DEFAULT_NODE_VERSION = 'v24.21.0';

const DIST = 'https://nodejs.org/dist';
const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = resolve(HERE, '..');

/** One downloadable runtime, and where its binary lands in our folder. */
const RUNTIMES = {
  'win-x64': { archive: (v) => `node-${v}-win-x64.zip`, inside: (v) => `node-${v}-win-x64/node.exe` },
  'linux-x64': { archive: (v) => `node-${v}-linux-x64.tar.gz`, inside: (v) => `node-${v}-linux-x64/bin/node` },
  'darwin-arm64': { archive: (v) => `node-${v}-darwin-arm64.tar.gz`, inside: (v) => `node-${v}-darwin-arm64/bin/node` },
  'darwin-x64': { archive: (v) => `node-${v}-darwin-x64.tar.gz`, inside: (v) => `node-${v}-darwin-x64/bin/node` },
};

const TARGETS = {
  windows: {
    asset: 'rippel-agent-windows.zip',
    runtimes: { 'win-x64': 'node/node.exe' },
  },
  macos: {
    asset: 'rippel-agent-macos.tar.gz',
    runtimes: { 'darwin-arm64': 'node/bin/node-arm64', 'darwin-x64': 'node/bin/node-x64' },
  },
  linux: {
    asset: 'rippel-agent-linux.tar.gz',
    runtimes: { 'linux-x64': 'node/bin/node' },
  },
};

function args() {
  const out = { node: process.env.RIPPEL_BUNDLE_NODE_VERSION || DEFAULT_NODE_VERSION, out: join(AGENT, 'dist'), only: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--node') (out.node = value.startsWith('v') ? value : `v${value}`), (i += 1);
    else if (flag === '--out') (out.out = resolve(value)), (i += 1);
    else if (flag === '--only') (out.only = value.split(',').map((s) => s.trim())), (i += 1);
    else throw new Error(`unknown argument ${flag}`);
  }
  return out;
}

function say(message) {
  process.stdout.write(`build: ${message}\n`);
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'rippel-agent-release-build' } });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download an official archive and refuse to use it unless its digest matches
 * the one in that release's SHASUMS256.txt.
 *
 * We are handing someone an executable to run on their own machine; taking it
 * on trust because it arrived over TLS is not enough. (The digest file itself
 * is signed by the Node release keys; verifying that signature needs GPG and a
 * keyring, which this box does not have, so what this check buys is integrity
 * against a corrupted or truncated transfer and against a mirror serving
 * something other than what the release lists.)
 */
async function fetchVerified(version, name, cacheDir) {
  const cached = join(cacheDir, `${version}-${name}`);
  const sums = await sumsFor(version, cacheDir);
  const expected = sums.get(name);
  if (!expected) throw new Error(`SHASUMS256.txt for ${version} does not list ${name}`);

  let bytes;
  if (existsSync(cached)) {
    bytes = readFileSync(cached);
  } else {
    say(`downloading ${name}`);
    bytes = await get(`${DIST}/${version}/${name}`);
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    if (existsSync(cached)) rmSync(cached);
    throw new Error(`${name} failed its checksum\n  expected ${expected}\n  got      ${actual}`);
  }
  if (!existsSync(cached)) writeFileSync(cached, bytes);
  say(`verified ${name} (${human(bytes.length)}) sha256 ${actual.slice(0, 16)}…`);
  return bytes;
}

const sumsCache = new Map();
async function sumsFor(version, cacheDir) {
  if (sumsCache.has(version)) return sumsCache.get(version);
  const path = join(cacheDir, `${version}-SHASUMS256.txt`);
  let text;
  if (existsSync(path)) {
    text = readFileSync(path, 'utf8');
  } else {
    text = (await get(`${DIST}/${version}/SHASUMS256.txt`)).toString('utf8');
    writeFileSync(path, text);
  }
  const map = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) map.set(match[2], match[1]);
  }
  sumsCache.set(version, map);
  return map;
}

/** Pull one member out of a .tar.gz, without unpacking the rest of it. */
function memberFromTarGz(archivePath, member) {
  return execFileSync('tar', ['-xzOf', archivePath, member], { maxBuffer: 512 * 1024 * 1024 });
}

function agentPayload(version, target, nodeVersion) {
  const files = [];
  for (const name of readdirSync(join(AGENT, 'src')).sort()) {
    if (name.endsWith('.mjs')) files.push({ name: `src/${name}`, data: readFileSync(join(AGENT, 'src', name)), mode: 0o644 });
  }
  files.push({ name: 'package.json', data: readFileSync(join(AGENT, 'package.json')), mode: 0o644 });
  files.push({ name: 'README.md', data: readFileSync(join(AGENT, 'README.md')), mode: 0o644 });
  files.push({
    name: 'release.json',
    mode: 0o644,
    data: Buffer.from(
      `${JSON.stringify(
        {
          agentVersion: version,
          nodeVersion,
          platform: target,
          builtAt: new Date().toISOString(),
          note: 'The node/ folder is an official Node.js build, unmodified, verified against nodejs.org SHASUMS256.txt at package time.',
        },
        null,
        2,
      )}\n`,
    ),
  });
  return files;
}

/** The one page someone who unzipped this rather than pasting the one-liner reads. */
function unpackNotes(target, nodeVersion) {
  const run =
    target === 'windows'
      ? '  .\\node\\node.exe src\\main.mjs'
      : target === 'macos'
        ? '  ./node/bin/node-arm64 src/main.mjs   # or node-x64 on an Intel Mac'
        : '  ./node/bin/node src/main.mjs';
  const oneLiner =
    target === 'windows'
      ? '  powershell -ExecutionPolicy Bypass -Command "irm \'<the URL rippel shows>\' | iex"'
      : "  curl -fsSL '<the URL rippel shows>' | bash";
  return `rippel agent — ${target}

This folder carries the agent and an official Node.js ${nodeVersion} runtime, so
the machine needs nothing preinstalled.

The normal path: open rippel → Settings → Deployment, add this machine, and
paste the install command it gives you **from inside this folder** —

${oneLiner}

The installer looks for node/ in the directory you run it from, copies the
runtime into ~/.rippel-agent, and registers the service against it. Run it
somewhere else and it will fall back to a system Node, or tell you it found
neither.

To run it by hand instead, write ~/.rippel-agent/config.json (see README.md)
and then, from this folder:

${run}

The runtime is Node's own build, unmodified. See release.json.
`;
}

async function buildTarget(target, opts, cacheDir) {
  const spec = TARGETS[target];
  const stage = join(cacheDir, `stage-${target}`);
  rmSync(stage, { recursive: true, force: true });
  const root = join(stage, 'rippel-agent');
  mkdirSync(root, { recursive: true });

  const pkg = JSON.parse(readFileSync(join(AGENT, 'package.json'), 'utf8'));
  const entries = agentPayload(pkg.version, target, opts.node);
  entries.push({ name: 'UNPACK-ME.txt', data: Buffer.from(unpackNotes(target, opts.node)), mode: 0o644 });

  for (const [runtime, dest] of Object.entries(spec.runtimes)) {
    const { archive, inside } = RUNTIMES[runtime];
    const name = archive(opts.node);
    const bytes = await fetchVerified(opts.node, name, cacheDir);
    let binary;
    if (name.endsWith('.zip')) {
      binary = readZipEntry(bytes, inside(opts.node));
    } else {
      binary = memberFromTarGz(join(cacheDir, `${opts.node}-${name}`), inside(opts.node));
    }
    if (!binary || binary.length < 1024) throw new Error(`could not find ${inside(opts.node)} in ${name}`);
    // The exec bit matters on every path out of here: tar records it, our zip
    // writer records it, and the installer re-applies it anyway because a
    // Windows unzip will have dropped it.
    entries.push({ name: dest, data: binary, mode: dest.endsWith('.exe') ? 0o644 : 0o755 });
    say(`  ${target}: ${dest} ← ${runtime} (${human(binary.length)})`);
  }

  mkdirSync(opts.out, { recursive: true });
  const assetPath = join(opts.out, spec.asset);

  if (spec.asset.endsWith('.zip')) {
    writeFileSync(assetPath, writeZip(entries.map((e) => ({ ...e, name: `rippel-agent/${e.name}` }))));
  } else {
    for (const entry of entries) {
      const path = join(root, entry.name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.data);
      chmodSync(path, entry.mode);
    }
    execFileSync('tar', [
      '-czf',
      assetPath,
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-C',
      stage,
      'rippel-agent',
    ]);
  }
  rmSync(stage, { recursive: true, force: true });
  return { asset: spec.asset, path: assetPath, size: statSync(assetPath).size };
}

async function main() {
  const opts = args();
  const targets = opts.only ?? Object.keys(TARGETS);
  for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t}`);

  const cacheDir = join(opts.out, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  say(`bundling Node ${opts.node}`);

  const built = [];
  for (const target of targets) built.push(await buildTarget(target, opts, cacheDir));

  say('done:');
  for (const b of built) process.stdout.write(`  ${b.path}  ${human(b.size)}\n`);
  process.stdout.write(
    `\nCached downloads live in ${cacheDir}; delete it to force a re-fetch.\n` +
      `Node bundled: ${opts.node}. If you change it, update the table in apps/agent/README.md.\n`,
  );
}


await main();
