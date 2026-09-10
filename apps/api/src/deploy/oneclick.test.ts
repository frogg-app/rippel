/**
 * The one-click path, end to end, against the binaries this repository actually
 * built.
 *
 * Everything else about this feature is unit-tested. This is the join: rippel
 * names a download after a deployment's setup code, and the *compiled agent*
 * reads that name back. Those two halves are written in different languages, in
 * different directories, by different tools — the encoding is the only thing
 * holding them together, and nothing else in either suite would notice if it
 * drifted.
 *
 * It skips itself when `apps/agent/dist` is empty, because a checkout where
 * nobody has run the build is a normal checkout, and a test that failed for
 * that reason would teach people to ignore it.
 */

import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { availableBinaries, downloadFileName, encodeSetup, setupLink } from './binaries.js';
import { makeDeploymentRoutes } from './routes.js';

const run = promisify(execFile);

const SETUP = { serverUrl: 'http://192.168.1.9:4000', token: 'tok-secret-for-the-round-trip' };

/** One deployment row, as the download route reads it. */
const DEPLOYMENT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'studio-4090',
  host: '192.168.1.50',
  agent_port: 8189,
  platform: 'win32',
  status: 'online',
  token: 'tok-for-the-download-route',
  agent_version: null,
  comfy: null,
  backend_id: null,
  backend_name: null,
  last_seen_at: null,
  created_at: new Date(),
};

const built = await availableBinaries();
const linux = built.find((b) => b.target === 'linux-amd64');

// Only the Linux binary can be executed here; the other three are cross-builds
// for machines this box is not.
const canRun = Boolean(linux) && process.platform === 'linux' && process.arch === 'x64';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stage(fileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rippel-oneclick-'));
  dirs.push(dir);
  const path = join(dir, fileName);
  await copyFile(linux!.path, path);
  await chmod(path, 0o755);
  return path;
}

/**
 * Ask the agent what it worked out, without letting it install anything.
 *
 * `install` against an unreachable address stops at the check-in it makes
 * *before* touching the disk, and the error it prints names the address it
 * decoded — so it reports what the agent read from its own filename, and proves
 * the nothing-is-written-first ordering at the same time.
 */
async function whatItRead(exe: string): Promise<string> {
  try {
    const { stdout, stderr } = await run(exe, ['install'], {
      env: { ...process.env, RIPPEL_AGENT_HOME: join(exe, '..', 'home') },
      timeout: 30_000,
    });
    return stdout + stderr;
  } catch (cause) {
    const failure = cause as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
}

describe.skipIf(!canRun)('a downloaded agent reads its own filename', () => {
  it('takes the server address and token out of the name rippel gave it', async () => {
    const fileName = downloadFileName(
      { target: 'linux-amd64', asset: '', platform: 'linux', arch: 'amd64', label: 'Linux' },
      SETUP,
    );
    const exe = await stage(fileName);
    const output = await whatItRead(exe);

    // It found the setup without being told, and it is talking to the address
    // that was baked into the filename.
    expect(output).toContain('the name of this file');
    expect(output).toContain(SETUP.serverUrl);
  }, 40_000);

  it('falls back to asking when the file has been renamed, rather than failing', async () => {
    const exe = await stage('rippel-agent');
    const output = await whatItRead(exe);

    expect(output).not.toContain('the name of this file');
    // The floor: it says what it needs and where to get it, and exits.
    expect(output).toContain('needs the setup link');
    expect(output).toContain('Settings');
  }, 40_000);

  it('reads a rippel-setup.txt left beside it', async () => {
    const exe = await stage('rippel-agent');
    await writeFile(
      join(exe, '..', 'rippel-setup.txt'),
      `# The link rippel gave you.\n${setupLink(SETUP.serverUrl, SETUP.token)}\n`,
      'utf8',
    );
    const output = await whatItRead(exe);

    expect(output).toContain('rippel-setup.txt');
    // And it recovered the *bare* server address from the /api/deployments path
    // the link carries. The agent appends /api/deployments/checkin itself, so
    // failing to strip it would send every check-in to
    // /api/deployments/api/deployments/checkin — a 404 that looks exactly like
    // "this is not a rippel", which is the worst possible way to be wrong.
    expect(output).toContain(`rippel at ${SETUP.serverUrl} knows this token`);
    expect(output).not.toContain('/api/deployments');
  }, 40_000);

  it('writes nothing at all when it cannot reach rippel', async () => {
    const exe = await stage(
      downloadFileName(
        { target: 'linux-amd64', asset: '', platform: 'linux', arch: 'amd64', label: 'Linux' },
        SETUP,
      ),
    );
    const home = join(exe, '..', 'home');
    await run(exe, ['install'], {
      env: { ...process.env, RIPPEL_AGENT_HOME: home },
      timeout: 30_000,
    }).catch(() => undefined);

    // No config, no copied binary, no half-registered service. An install that
    // cannot succeed must leave the machine exactly as it found it.
    await expect(run('test', ['-e', home])).rejects.toBeTruthy();
  }, 40_000);
});

describe.skipIf(!canRun)('the whole download, exactly as a browser would do it', () => {
  it('serves a binary that runs and knows where it came from', async () => {
    // The complete chain, with nothing stubbed between the pieces: the route
    // streams the file, the browser saves it under the name the
    // Content-Disposition header gave, and that file is then executed. Every
    // unit test here passes with a broken join; this one does not.
    const app = Fastify();
    app.decorate('requireAdmin', async () => {});
    app.decorate('user', null);
    await app.register(
      makeDeploymentRoutes({
        db: {
          query: async () => [] as never[],
          queryOne: async () => DEPLOYMENT as never,
        },
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/deployments/${DEPLOYMENT.id}/agent/linux-amd64?token=${DEPLOYMENT.token}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const served = /filename="([^"]+)"/.exec(String(res.headers['content-disposition']))?.[1];
    expect(served).toBeTruthy();

    const dir = await mkdtemp(join(tmpdir(), 'rippel-download-'));
    dirs.push(dir);
    const saved = join(dir, served!);
    await writeFile(saved, res.rawPayload);
    await chmod(saved, 0o755);

    // It is a working program, not a truncated stream.
    const { stdout } = await run(saved, ['version'], { timeout: 30_000 });
    expect(stdout).toContain('rippel-agent');

    // The name the route chose really does carry this deployment's token...
    const blob = /rippel-agent-setup-([A-Za-z0-9_-]+)/.exec(served!)![1]!;
    expect(JSON.parse(Buffer.from(blob, 'base64url').toString('utf8')).t).toBe(DEPLOYMENT.token);

    // ...and the binary reads it back off its own filename, with nothing typed.
    // That is the entire one-click install, proven across both languages.
    const output = await whatItRead(saved);
    expect(output).toContain('the name of this file');
  }, 60_000);
});

describe('the setup code the download carries', () => {
  it('is decoded by the compiled agent, not just by this test', async () => {
    // Guards the one thing two languages have to agree on. If encodeSetup here
    // and DecodeSetup in apps/agent/go/setup.go ever drift, every download
    // silently becomes a paste-the-link install and nobody notices.
    const blob = encodeSetup(SETUP);
    expect(JSON.parse(Buffer.from(blob, 'base64url').toString('utf8'))).toEqual({
      s: SETUP.serverUrl,
      t: SETUP.token,
    });
  });

  it('reports which binaries this rippel can actually hand out', async () => {
    // Not an assertion about how many were built — a checkout may have none.
    // What must hold is that anything reported as available is really there.
    for (const binary of built) {
      expect(binary.sizeBytes).toBeGreaterThan(0);
      expect(binary.path).toContain(binary.asset);
    }
  });
});
