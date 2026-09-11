/**
 * Pairing, end to end, against the binary this repository actually built.
 *
 * Everything else about this feature is unit-tested on one side or the other.
 * This is the join: rippel issues a code and the *compiled agent* redeems it.
 * Those two halves are written in different languages, in different
 * directories, by different tools — the code's alphabet, its normalisation and
 * the shape of `POST /deployments/pair` are the only things holding them
 * together, and nothing else in either suite would notice if they drifted.
 *
 * It skips the executing tests when `apps/agent/dist` is empty, because a
 * checkout where nobody has run the build is a normal checkout, and a test that
 * failed for that reason would teach people to ignore it.
 */

import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { availableBinaries } from './binaries.js';
import { generateCode, hashCode, normaliseCode, resetPairingLimits } from './pairing.js';
import { makeDeploymentRoutes } from './routes.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

/** One deployment row, as the pair route reads it. */
const DEPLOYMENT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'studio-4090',
  host: '192.168.1.50',
  agent_port: 8189,
  platform: 'linux',
  status: 'online',
  token: 'tok-for-the-pairing-round-trip',
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

async function stage(): Promise<{ exe: string; home: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'rippel-pair-'));
  dirs.push(dir);
  const exe = join(dir, 'rippel-agent');
  await copyFile(linux!.path, exe);
  await chmod(exe, 0o755);
  return { exe, home: join(dir, 'home') };
}

/**
 * A real rippel, listening on a real port, with one deployment and one code.
 *
 * `inject` cannot be used here: the thing making the request is a separate
 * process, so there has to be a socket.
 */
async function rippel(code: string, opts: { expired?: boolean } = {}) {
  resetPairingLimits();
  const codes = [
    {
      deployment_id: DEPLOYMENT.id,
      code_hash: hashCode(code),
      expires_at: new Date(Date.now() + (opts.expired ? -1000 : 15 * 60 * 1000)),
      redeemed_at: null as Date | null,
    },
  ];

  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    (req as FastifyRequest & { user: unknown }).user = null;
  });
  app.decorate('requireAdmin', async (_req: FastifyRequest, reply: FastifyReply) => {
    await reply.code(401).send({ error: 'unauthorized' });
  });

  const query = (async (sql: string, params: unknown[] = []) => {
    if (sql.includes('UPDATE deployment_pairing_codes')) {
      const found = codes.find(
        (c) => c.code_hash === params[0] && !c.redeemed_at && c.expires_at > new Date(),
      );
      if (!found) return [];
      found.redeemed_at = new Date();
      return [{ deployment_id: found.deployment_id }];
    }
    if (sql.includes('FROM deployment_pairing_codes')) {
      return codes.filter((c) => c.code_hash === params[0]);
    }
    if (sql.includes('FROM deployments d') && sql.includes('d.id = $1')) {
      return params[0] === DEPLOYMENT.id ? [DEPLOYMENT] : [];
    }
    if (sql.startsWith('UPDATE deployments')) return [{ id: DEPLOYMENT.id }];
    return [];
  }) as never;

  // Under /api, exactly as index.ts mounts them. The agent appends
  // /api/deployments/pair to whatever address it was given, so a harness that
  // mounted these at the root would test a path no real agent ever calls.
  await app.register(
    makeDeploymentRoutes({
      db: { query, queryOne: (async (sql, params) => (await query(sql, params))[0] ?? null) as never },
    }),
    { prefix: '/api' },
  );
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, url, codes };
}

describe.skipIf(!canRun)('a real agent pairs with a real rippel', () => {
  it('redeems a code, and remembers what it was given', async () => {
    const code = generateCode();
    const { app, url } = await rippel(code);
    const { exe, home } = await stage();

    try {
      const { stdout } = await run(
        exe,
        ['install', '--server', url, '--code', code],
        {
          env: {
            ...process.env,
            RIPPEL_AGENT_HOME: home,
            // Never register a startup entry on whatever machine runs the suite.
            RIPPEL_SKIP_SERVICE: '1',
          },
          timeout: 30_000,
        },
      );
      expect(stdout).toContain('Paired.');

      // The whole point: the id came back from redemption. Nobody typed it, and
      // the agent never asked for one.
      const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
      expect(config.deploymentId).toBe(DEPLOYMENT.id);
      expect(config.token).toBe(DEPLOYMENT.token);
      expect(config.serverUrl).toBe(url.replace(/\/+$/, ''));
    } finally {
      await app.close();
    }
  }, 60_000);

  it('refuses the same code the second time, and says so in words', async () => {
    const code = generateCode();
    const { app, url } = await rippel(code);
    const first = await stage();
    const second = await stage();

    try {
      // The first machine pairs, which spends the code.
      await run(first.exe, ['install', '--server', url, '--code', code], {
        env: { ...process.env, RIPPEL_AGENT_HOME: first.home, RIPPEL_SKIP_SERVICE: '1' },
        timeout: 30_000,
      }).catch(() => undefined);

      const failure = await run(second.exe, ['install', '--server', url, '--code', code], {
        env: { ...process.env, RIPPEL_AGENT_HOME: second.home, RIPPEL_SKIP_SERVICE: '1' },
        timeout: 30_000,
      }).then(
        () => ({ stdout: '', stderr: '' }),
        (cause: { stdout?: string; stderr?: string }) => ({
          stdout: cause.stdout ?? '',
          stderr: cause.stderr ?? '',
        }),
      );

      expect(`${failure.stdout}${failure.stderr}`).toContain('already been used');
      // And it wrote nothing: a machine that could not pair must be left exactly
      // as it was found.
      await expect(run('test', ['-e', second.home])).rejects.toBeTruthy();
    } finally {
      await app.close();
    }
  }, 90_000);

  it('refuses an expired code, and writes nothing', async () => {
    const code = generateCode();
    const { app, url } = await rippel(code, { expired: true });
    const { exe, home } = await stage();

    try {
      const failure = await run(exe, ['install', '--server', url, '--code', code], {
        env: { ...process.env, RIPPEL_AGENT_HOME: home, RIPPEL_SKIP_SERVICE: '1' },
        timeout: 30_000,
      }).then(
        () => ({ out: '' }),
        (cause: { stdout?: string; stderr?: string }) => ({
          out: `${cause.stdout ?? ''}${cause.stderr ?? ''}`,
        }),
      );

      expect(failure.out).toContain('expired');
      await expect(run('test', ['-e', home])).rejects.toBeTruthy();
    } finally {
      await app.close();
    }
  }, 60_000);

  it('is a working program, not a truncated stream, when served by the route', async () => {
    const { app } = await rippel(generateCode());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/deployments/agent/linux-amd64' });
      expect(res.statusCode).toBe(200);
      // The same file for everybody: no deployment in the name, nothing secret
      // in it, and therefore cacheable.
      expect(String(res.headers['content-disposition'])).toContain('rippel-agent-linux-amd64');
      expect(String(res.headers['cache-control'])).toContain('public');
      expect(res.rawPayload.subarray(0, 4).toString('latin1')).toBe('\x7fELF');

      const dir = await mkdtemp(join(tmpdir(), 'rippel-download-'));
      dirs.push(dir);
      const saved = join(dir, 'rippel-agent');
      await import('node:fs/promises').then((fs) => fs.writeFile(saved, res.rawPayload));
      await chmod(saved, 0o755);
      const { stdout } = await run(saved, ['version'], { timeout: 30_000 });
      expect(stdout).toContain('rippel-agent');
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe('the pairing code, as both sides spell it', () => {
  it('uses an alphabet the compiled agent agrees with, character for character', async () => {
    // The one thing two languages have to agree on. If the alphabet here and
    // `pairingAlphabet` in apps/agent/go/setup.go ever drift, codes this rippel
    // issues become codes that agent refuses to even send — and the failure
    // reads as "rippel does not recognise that code", which sends everyone
    // hunting in the wrong place.
    const goSource = await readFile(
      join(here, '..', '..', '..', 'agent', 'go', 'setup.go'),
      'utf8',
    );
    const goAlphabet = /pairingAlphabet = "([^"]+)"/.exec(goSource)?.[1];
    expect(goAlphabet).toBeTruthy();

    // Derive this side's alphabet from the generator rather than re-declaring
    // it, so the test cannot pass against a constant nobody uses.
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) for (const c of generateCode()) seen.add(c);
    expect([...seen].sort().join('')).toBe([...goAlphabet!].sort().join(''));

    // And the exclusions the whole scheme rests on.
    for (const ambiguous of ['O', '0', 'I', '1', 'L']) {
      expect(goAlphabet).not.toContain(ambiguous);
    }
  });

  it('agrees on the length, and on what normalisation forgives', () => {
    const goSource = () => readFile(join(here, '..', '..', '..', 'agent', 'go', 'setup.go'), 'utf8');
    expect(generateCode()).toHaveLength(8);
    // The separators a person adds, which both sides strip before hashing. A
    // disagreement here means a code that works when typed one way and not the
    // other, which is the least debuggable failure this feature could have.
    expect(normaliseCode('k7qm-4xtb')).toBe('K7QM4XTB');
    expect(normaliseCode('K7QM 4XTB')).toBe('K7QM4XTB');
    expect(normaliseCode(' K7QM4XTB ')).toBe('K7QM4XTB');
    return goSource().then((source) => {
      expect(source).toContain('PairingCodeLength = 8');
    });
  });
});
