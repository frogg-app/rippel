/**
 * The deployment routes against an in-memory table and a scripted agent: the
 * gating, the three authentications, the check-in that corrects a row, the
 * refusals, and the scripts. No Postgres, no SSH, no agent.
 *
 * The authentications are the point of most of this. An administrator has a
 * session and no token; an agent has a token and no session; a machine being
 * paired has neither, and a one-time code stands in. Confusing any two of them
 * is the failure that matters — an admin route reachable by token would let a
 * GPU box read the fleet, a token route behind requireAdmin would mean no agent
 * could ever check in, and a pairing route behind either would mean nothing
 * could be set up at all.
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask, ComfyState } from '@comfy/shared';
import { makeDeploymentRoutes, normaliseHost, type DeployDb } from './routes.js';
import { bashInstaller, oneLiner, powershellInstaller } from './scripts.js';
import { clearReleaseCache, latestAgentRelease } from './releases.js';
import { AGENT_BINARIES, availableBinaries, binaryDownloadPath } from './binaries.js';
import {
  CODE_LENGTH,
  generateCode,
  hashCode,
  hashesMatch,
  normaliseCode,
  RateLimiter,
  resetPairingLimits,
} from './pairing.js';
import type { AgentClient } from './agent-client.js';
import { AgentError } from './agent-client.js';

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' as const };
const USER = { id: '22222222-2222-4222-8222-222222222222', role: 'user' as const };
const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const COMFY: ComfyState = {
  installed: true,
  running: true,
  path: '/home/steve/.rippel-agent/ComfyUI',
  version: '0.34.0',
  commit: 'abc1234',
  port: 8188,
  helperInstalled: true,
  helperReady: true,
  diskFree: 400_000_000_000,
  diskTotal: 2_000_000_000_000,
};

interface Row {
  id: string;
  name: string;
  host: string;
  agent_port: number;
  platform: string;
  status: string;
  token: string;
  agent_version: string | null;
  comfy: ComfyState | null;
  backend_id: string | null;
  backend_name: string | null;
  memory_profile: string;
  cpu_vae: boolean;
  last_seen_at: Date | null;
  created_at: Date;
}

/** A pairing code row, as the table stores it: a hash and two timestamps. */
interface CodeRow {
  deployment_id: string;
  code_hash: string;
  expires_at: Date;
  redeemed_at: Date | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: D1,
    name: 'studio-4090',
    host: '192.168.1.50',
    agent_port: 8189,
    platform: 'linux',
    status: 'online',
    token: 'tok-secret',
    agent_version: '0.1.0',
    comfy: COMFY,
    backend_id: null,
    backend_name: null,
    memory_profile: 'balanced',
    cpu_vae: false,
    last_seen_at: new Date(),
    created_at: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

function fakeDb(
  rows: Row[],
  backends: { id: string; name: string; base_url: string }[] = [],
  codes: CodeRow[] = [],
): DeployDb {
  let next = 0;
  const query = (async (sql: string, params: unknown[] = []) => {
    // ---- pairing codes. Checked first: the generic `UPDATE deployments`
    // matcher below would otherwise swallow the redemption statement.
    if (sql.includes('INSERT INTO deployment_pairing_codes')) {
      const [deployment_id, code_hash, expires_at] = params as [string, string, Date];
      const existing = codes.find((c) => c.deployment_id === deployment_id);
      if (existing) {
        // The primary key means issuing replaces, which is what invalidates an
        // outstanding code. Modelled here because that is the behaviour tested.
        existing.code_hash = code_hash;
        existing.expires_at = expires_at;
        existing.redeemed_at = null;
      } else {
        codes.push({ deployment_id, code_hash, expires_at, redeemed_at: null });
      }
      return [];
    }
    if (sql.includes('UPDATE deployment_pairing_codes')) {
      // The one statement that may spend a code, and the reason redemption is
      // single-use: the condition and the write are one step.
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
      return rows.filter((r) => r.id === params[0]);
    }
    if (sql.includes('FROM deployments d') && sql.includes('d.token = $1')) {
      return rows.filter((r) => r.token === params[0]);
    }
    if (sql.includes('FROM deployments d')) return [...rows];
    if (sql.includes('FROM deployments WHERE lower(name)')) {
      const name = (params[0] as string).toLowerCase();
      return rows.filter((r) => r.name.toLowerCase() === name).map((r) => ({ id: r.id }));
    }
    if (sql.includes('INSERT INTO deployments')) {
      const [name, host, agent_port, ...rest] = params as [string, string, number, ...unknown[]];
      const platform = rest.length === 3 ? (rest[0] as string) : 'unknown';
      const token = rest.length === 3 ? (rest[1] as string) : (rest[0] as string);
      const made = row({
        id: `new-${++next}`,
        name,
        host,
        agent_port,
        platform,
        status: 'pending',
        token,
        agent_version: null,
        comfy: null,
        last_seen_at: null,
      });
      rows.push(made);
      return [made];
    }
    if (sql.startsWith('UPDATE deployments\n            SET status = \'online\'')) {
      const target = rows.find((r) => r.id === params[0])!;
      target.host = params[1] as string;
      if (params[2]) target.platform = params[2] as string;
      if (params[4]) target.agent_version = params[4] as string;
      if (params[5]) target.comfy = JSON.parse(params[5] as string) as ComfyState;
      target.status = 'online';
      target.last_seen_at = new Date();
      return [{ id: target.id }];
    }
    if (sql.startsWith('UPDATE deployments')) {
      const target = rows.find((r) => r.id === params[0]);
      if (!target) return [];
      if (sql.includes("status = 'offline'")) target.status = 'offline';
      if (sql.includes('memory_profile = $2')) {
        target.memory_profile = params[1] as string;
        target.cpu_vae = params[2] as boolean;
      }
      if (sql.includes('backend_id = $2')) {
        target.backend_id = params[1] as string;
        target.backend_name = backends.find((b) => b.id === params[1])?.name ?? null;
      }
      return [{ id: target.id }];
    }
    if (sql.startsWith('DELETE FROM deployments')) {
      const i = rows.findIndex((r) => r.id === params[0]);
      if (i >= 0) rows.splice(i, 1);
      return [];
    }
    if (sql.includes('FROM backends WHERE lower(name)')) {
      const name = (params[0] as string).toLowerCase();
      const url = params[1] as string;
      return backends.filter((b) => b.name.toLowerCase() === name || b.base_url === url).map((b) => ({ id: b.id }));
    }
    if (sql.startsWith('INSERT INTO backends')) {
      const made = { id: `backend-${++next}`, name: params[0] as string, base_url: params[1] as string };
      backends.push(made);
      return [{ id: made.id }];
    }
    throw new Error(`fake db: unexpected query ${sql}`);
  }) as DeployDb['query'];
  return {
    query,
    queryOne: (async (sql, params) => (await query(sql, params))[0] ?? null) as DeployDb['queryOne'],
  };
}

function task(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    kind: 'install-comfyui',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
    error: null,
    ...over,
  };
}

function fakeAgent(over: Partial<AgentClient> = {}): AgentClient {
  return {
    ping: async () => ({ ok: true, version: '0.1.0', platform: 'linux', hostname: 'studio' }),
    status: async () => ({
      ok: true,
      version: '0.1.0',
      platform: 'linux',
      hostname: 'studio',
      comfy: COMFY,
      accelerator: 'cuda',
      tasks: [],
    }),
    task: async () => ({ task: task({ status: 'done' }), logOffset: 0 }),
    installComfy: async () => task(),
    updateComfy: async () => task({ kind: 'update-comfyui' }),
    power: async () => ({ started: true }),
    installHelper: async () => task({ kind: 'install-helper' }),
    comfyLog: async () => [],
    updateConfig: async () => {},
    ...over,
  };
}

async function server(
  user: { id: string; role: 'admin' | 'user' } | null,
  opts: {
    rows?: Row[];
    backends?: { id: string; name: string; base_url: string }[];
    codes?: CodeRow[];
    agent?: AgentClient;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    (req as FastifyRequest & { user: unknown }).user = user;
  });
  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) await reply.code(401).send({ error: 'unauthorized' });
  });
  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    if (req.user.role !== 'admin') await reply.code(403).send({ error: 'forbidden' });
  });
  await app.register(
    makeDeploymentRoutes({
      db: fakeDb(opts.rows ?? [], opts.backends ?? [], opts.codes ?? []),
      agent: opts.agent ?? fakeAgent(),
      fetchImpl: opts.fetchImpl,
      pollNow: async () => {},
    }),
  );
  await app.ready();
  return app;
}

// The limiters are module-level and therefore shared between tests.
beforeEach(() => resetPairingLimits());

// ---------------------------------------------------------------- host

describe('normaliseHost', () => {
  it('takes a name or an address', () => {
    expect(normaliseHost('192.168.1.50')).toBe('192.168.1.50');
    expect(normaliseHost('  Studio-4090.local ')).toBe('studio-4090.local');
    expect(normaliseHost('[fe80::1]')).toBe('[fe80::1]');
  });

  it('refuses a URL rather than quietly stripping it', () => {
    // Someone pasting the ComfyUI address here has answered a different
    // question, and keeping the host would build a deployment that never talks.
    expect(normaliseHost('http://192.168.1.50:8188')).toBeNull();
    expect(normaliseHost('box/path')).toBeNull();
    expect(normaliseHost('user@box')).toBeNull();
    expect(normaliseHost('')).toBeNull();
    expect(normaliseHost(42)).toBeNull();
  });
});

// ---------------------------------------------------------------- the code

describe('the pairing code itself', () => {
  it('is eight characters with nothing ambiguous in it', () => {
    // O/0 and I/1/L are the pairs people confuse in both directions — reading a
    // code aloud, and typing one they were sent. Excluding both members of each
    // pair is stronger than mapping one onto the other, because it means no
    // code can *contain* an ambiguous character.
    for (let i = 0; i < 500; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
      for (const ambiguous of ['O', '0', 'I', '1', 'L']) {
        expect(code).not.toContain(ambiguous);
      }
    }
  });

  it('forgives case and the separators people add, and nothing else', () => {
    expect(normaliseCode('k7qm4xtb')).toBe('K7QM4XTB');
    expect(normaliseCode('K7QM-4XTB')).toBe('K7QM4XTB');
    expect(normaliseCode(' K7QM 4XTB ')).toBe('K7QM4XTB');

    // A character the alphabet excludes is a misreading, not something to fold:
    // there is nothing sensible to map an O onto when neither O nor 0 is ever
    // in a code. Refusing is the honest answer.
    expect(normaliseCode('K7QM4XTO')).toBeNull();
    expect(normaliseCode('K7QM4XT0')).toBeNull();
    expect(normaliseCode('K7QM4XT')).toBeNull();
    expect(normaliseCode('K7QM4XTBB')).toBeNull();
    expect(normaliseCode(42)).toBeNull();
    expect(normaliseCode(null)).toBeNull();
  });

  it('is stored as a hash and compared without a shortcut', () => {
    const code = generateCode();
    // Case-insensitivity has to survive hashing, or a lowercase paste fails.
    expect(hashCode(normaliseCode(code.toLowerCase())!)).toBe(hashCode(code));
    expect(hashCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode(code)).not.toContain(code);

    expect(hashesMatch(hashCode(code), hashCode(code))).toBe(true);
    expect(hashesMatch(hashCode(code), hashCode(generateCode()))).toBe(false);
    // Mismatched lengths must not throw, which timingSafeEqual does on its own.
    expect(hashesMatch('abcd', hashCode(code))).toBe(false);
    expect(hashesMatch('', '')).toBe(false);
  });

  it('counts attempts in a window and forgets a key on success', () => {
    const limiter = new RateLimiter(3, 1000);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    // Another caller is unaffected.
    expect(limiter.take('b')).toBe(true);
    // The window rolls.
    expect(limiter.take('a', Date.now() + 2000)).toBe(true);

    limiter.take('c');
    limiter.clear('c');
    expect(limiter.take('c')).toBe(true);
  });
});

// ---------------------------------------------------------------- pairing

describe('pairing a machine', () => {
  it('issues a code to an administrator, and nobody else', async () => {
    for (const who of [null, USER]) {
      const app = await server(who, { rows: [row()] });
      const res = await app.inject({ method: 'POST', url: `/deployments/${D1}/pairing-code` });
      expect(res.statusCode).toBe(who ? 403 : 401);
    }

    const codes: CodeRow[] = [];
    const app = await server(ADMIN, { rows: [row()], codes });
    const res = await app.inject({ method: 'POST', url: `/deployments/${D1}/pairing-code` });
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // Minutes, not days. A credential read aloud should not outlive the meeting.
    expect(new Date(body.expiresAt).getTime()).toBeLessThan(Date.now() + 60 * 60 * 1000);

    // Only the hash is stored — an administrator looking at the table cannot
    // recover a code, and neither can a database dump.
    expect(codes).toHaveLength(1);
    expect(codes[0].code_hash).toBe(hashCode(body.code));
    expect(JSON.stringify(codes)).not.toContain(body.code);
  });

  it('redeems a code with no session at all, and hands back the id', async () => {
    const codes: CodeRow[] = [];
    const admin = await server(ADMIN, { rows: [row()], codes });
    const { code } = (await admin.inject({ method: 'POST', url: `/deployments/${D1}/pairing-code` })).json();

    // A different app with no user: this is the machine being set up, which has
    // no rippel login. That is the whole reason the code exists.
    const machine = await server(null, { rows: [row()], codes });
    const res = await machine.inject({
      method: 'POST',
      url: '/deployments/pair',
      payload: { code },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    // The id comes *back* from redemption. The agent never asks for one.
    expect(body.deploymentId).toBe(D1);
    expect(body.token).toBe('tok-secret');
    expect(body.serverUrl).toMatch(/^https?:\/\//);
  });

  it('takes the code in whatever case and shape it was written down', async () => {
    const codes: CodeRow[] = [];
    const admin = await server(ADMIN, { rows: [row()], codes });
    const { code } = (await admin.inject({ method: 'POST', url: `/deployments/${D1}/pairing-code` })).json();

    const machine = await server(null, { rows: [row()], codes });
    const res = await machine.inject({
      method: 'POST',
      url: '/deployments/pair',
      payload: { code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('lets exactly one of two agents racing the same code win', async () => {
    // The requirement, and the reason redemption is a single conditional UPDATE
    // rather than a read followed by a write: two machines handed the same code
    // must not both end up enrolled.
    const codes: CodeRow[] = [];
    const admin = await server(ADMIN, { rows: [row()], codes });
    const { code } = (await admin.inject({ method: 'POST', url: `/deployments/${D1}/pairing-code` })).json();

    const machine = await server(null, { rows: [row()], codes });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        machine.inject({ method: 'POST', url: '/deployments/pair', payload: { code } }),
      ),
    );

    const winners = results.filter((r) => r.statusCode === 200);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.json().token).toBe('tok-secret');
    // Everyone else is told the code is spent, not that it never existed.
    for (const loser of results.filter((r) => r.statusCode !== 200)) {
      expect(loser.statusCode).toBe(409);
      expect(loser.json().message).toContain('already been used');
    }
    expect(codes[0].redeemed_at).toBeTruthy();
  });

  it('refuses a code that has expired, and says which it is', async () => {
    const codes: CodeRow[] = [
      {
        deployment_id: D1,
        code_hash: hashCode('K7QM4XTB'),
        expires_at: new Date(Date.now() - 1000),
        redeemed_at: null,
      },
    ];
    const app = await server(null, { rows: [row()], codes });
    const res = await app.inject({
      method: 'POST',
      url: '/deployments/pair',
      payload: { code: 'K7QM4XTB' },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('code_expired');
    // Whoever holds the code already holds it, so telling them it is stale is
    // not a disclosure — and "not valid" for every case sends people hunting
    // for typos that are not there.
    expect(res.json().message).toContain('expired');
  });

  it('invalidates an outstanding code when a new one is issued', async () => {
    // A code read aloud in a meeting cannot be used tomorrow.
    const codes: CodeRow[] = [];
    const admin = await server(ADMIN, { rows: [row()], codes });
    const first = (await admin.inject({ method: 'POST', url: `/deployments/${D1}/pairing-code` })).json();
    const second = (await admin.inject({ method: 'POST', url: `/deployments/${D1}/pairing-code` })).json();
    expect(second.code).not.toBe(first.code);
    expect(codes).toHaveLength(1);

    const machine = await server(null, { rows: [row()], codes });
    const stale = await machine.inject({
      method: 'POST',
      url: '/deployments/pair',
      payload: { code: first.code },
    });
    expect(stale.statusCode).toBe(404);

    const fresh = await machine.inject({
      method: 'POST',
      url: '/deployments/pair',
      payload: { code: second.code },
    });
    expect(fresh.statusCode).toBe(200);
  });

  it('refuses a malformed code without going near the database', async () => {
    // The db here throws on any unexpected query, so a lookup would fail loudly.
    const app = await server(null, { rows: [row()], codes: [] });
    for (const code of ['', 'nope', 'K7QM4XT0', 'K7QM4XTBB', 12345678, null]) {
      const res = await app.inject({ method: 'POST', url: '/deployments/pair', payload: { code } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_code');
    }
  });

  it('rate-limits guessing from one address', async () => {
    const app = await server(null, { rows: [row()], codes: [] });
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/deployments/pair',
        payload: { code: generateCode() },
        remoteAddress: '203.0.113.9',
      });

    // Ten in the window are answered; the eleventh is not.
    for (let i = 0; i < 10; i++) {
      expect((await attempt()).statusCode).toBe(404);
    }
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().message).toContain('Too many');
  });

  it('never puts the code in a URL', async () => {
    // It is a credential, so it goes in a body — not in a path a proxy logs, a
    // browser remembers, or a referrer header leaks.
    const codes: CodeRow[] = [];
    const admin = await server(ADMIN, { rows: [row()], codes });
    const res = await admin.inject({ method: 'POST', url: `/deployments/${D1}/pairing-code` });
    const { code, commands } = res.json();
    for (const command of Object.values(commands) as string[]) {
      expect(command).toContain(code);
      // Present as an argument, never as part of a fetched URL.
      expect(command).not.toMatch(new RegExp(`[?&][^ ]*${code}`));
    }
  });
});

// ---------------------------------------------------------------- gating

describe('who may call what', () => {
  it('keeps the admin routes away from a signed-in user', async () => {
    const app = await server(USER, { rows: [row()] });
    for (const url of ['/deployments', `/deployments/${D1}/install`]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: `/deployments/${D1}/probe` })).statusCode).toBe(403);
  });

  it('lets an agent check in with only its token', async () => {
    const rows = [row({ status: 'pending', host: 'pending', comfy: null, agent_version: null })];
    const app = await server(null, { rows });
    const res = await app.inject({
      method: 'POST',
      url: '/deployments/checkin',
      headers: { 'x-rippel-agent-token': 'tok-secret' },
      payload: { version: '0.1.0', platform: 'linux', comfy: COMFY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deploymentId).toBe(D1);
    expect(rows[0].status).toBe('online');
    expect(rows[0].agent_version).toBe('0.1.0');
    expect(rows[0].comfy?.version).toBe('0.34.0');
    // The row was created with no address; the check-in supplied the real one.
    expect(rows[0].host).not.toBe('pending');
  });

  it('refuses a check-in with no token or a wrong one', async () => {
    const app = await server(null, { rows: [row()] });
    expect((await app.inject({ method: 'POST', url: '/deployments/checkin', payload: {} })).statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/deployments/checkin',
      headers: { 'x-rippel-agent-token': 'nope' },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('no longer takes a long-lived token from a query string', async () => {
    // There is no `curl | bash` script left that needs one, so there is no
    // reason for the agent token to appear in a URL — where a proxy logs it and
    // a browser history keeps it.
    const app = await server(null, { rows: [row()] });
    const res = await app.inject({
      method: 'POST',
      url: '/deployments/checkin?token=tok-secret',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('serves the agent binary to anyone, because it is the same file for everyone', async () => {
    const app = await server(null, { rows: [row()] });
    const res = await app.inject({ method: 'GET', url: binaryDownloadPath('linux-amd64').replace('/api', '') });

    const built = await availableBinaries();
    if (built.some((b) => b.target === 'linux-amd64')) {
      expect(res.statusCode).toBe(200);
      // A plain, cacheable asset under its own name — no setup blob, nothing
      // per-deployment, and nothing a rename could break.
      const disposition = String(res.headers['content-disposition']);
      expect(disposition).toContain('rippel-agent-linux-amd64');
      expect(disposition).not.toContain('setup');
      expect(String(res.headers['cache-control'])).toContain('public');
      // ELF, because that is what a Linux download has to be.
      expect(res.rawPayload.subarray(0, 4).toString('latin1')).toBe('\x7fELF');
    } else {
      // 404 when this rippel has not built its binaries, which is a normal
      // state for a checkout — but never a silent empty file.
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('build:release');
    }
  });

  it('refuses a platform it has never heard of, and says which it knows', async () => {
    const app = await server(null, { rows: [row()] });
    const res = await app.inject({ method: 'GET', url: '/deployments/agent/solaris-sparc' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('windows-amd64');
  });
});

// ---------------------------------------------------------------- admin work

describe('managing a deployment', () => {
  it('creates one, with a token nobody chose', async () => {
    const rows: Row[] = [];
    const app = await server(ADMIN, { rows });
    const res = await app.inject({
      method: 'POST',
      url: '/deployments',
      payload: { name: 'studio', host: '192.168.1.50' },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().deployment;
    expect(created.status).toBe('pending');
    expect(created.token).toHaveLength(43); // 32 bytes, base64url
    expect(rows).toHaveLength(1);
  });

  it('refuses a duplicate name and a URL for a host', async () => {
    const app = await server(ADMIN, { rows: [row()] });
    const dupe = await app.inject({
      method: 'POST',
      url: '/deployments',
      payload: { name: 'Studio-4090', host: '10.0.0.2' },
    });
    expect(dupe.statusCode).toBe(409);

    const url = await app.inject({
      method: 'POST',
      url: '/deployments',
      payload: { name: 'other', host: 'http://10.0.0.2:8188' },
    });
    expect(url.statusCode).toBe(400);
    expect(url.json().field).toBe('host');
  });

  it('describes an install without minting a credential', async () => {
    // A GET is safe and is polled by the panel. If it issued a pairing code,
    // every refresh would silently invalidate the one on screen.
    const codes: CodeRow[] = [];
    const app = await server(ADMIN, { rows: [row()], codes });
    const res = await app.inject({ method: 'GET', url: `/deployments/${D1}/install` });
    expect(res.statusCode).toBe(200);
    expect(codes).toHaveLength(0);

    const body = res.json();
    expect(body.serverUrl).toMatch(/^https?:\/\//);
    expect(body.release).toBeTruthy();
    // The retired per-deployment mechanism, gone from the payload.
    expect(body.setupLink).toBeUndefined();
    expect(body.downloads).toBeUndefined();
    for (const binary of body.binaries ?? []) {
      expect(binary.url).toContain('/api/deployments/agent/');
      expect(binary.url).not.toContain('token');
      expect(binary.fileName).not.toContain('setup');
    }
  });

  it('reports a machine as offline once it stops checking in', async () => {
    const stale = row({ last_seen_at: new Date(Date.now() - 10 * 60 * 1000) });
    const app = await server(ADMIN, { rows: [stale] });
    const [seen] = (await app.inject({ method: 'GET', url: '/deployments' })).json().deployments;
    // The column still says online; silence is what makes it not.
    expect(stale.status).toBe('online');
    expect(seen.status).toBe('offline');
  });

  it('turns an agent failure into a gateway error, not a 500', async () => {
    const rows = [row()];
    const app = await server(ADMIN, {
      rows,
      agent: fakeAgent({
        status: async () => {
          throw new AgentError('unreachable', 'studio did not answer within 15s.');
        },
      }),
    });
    const res = await app.inject({ method: 'GET', url: `/deployments/${D1}/status` });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('did not answer');
    expect(rows[0].status).toBe('offline');
  });

  it('passes a busy agent through as a conflict', async () => {
    const app = await server(ADMIN, {
      rows: [row()],
      agent: fakeAgent({
        installComfy: async () => {
          throw new AgentError('busy', 'A install-comfyui is already running on this machine.', 409);
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/deployments/${D1}/comfyui/install`,
      payload: { accelerator: 'auto' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('checks the accelerator before bothering the agent', async () => {
    const installComfy = vi.fn();
    const app = await server(ADMIN, { rows: [row()], agent: fakeAgent({ installComfy }) });
    const res = await app.inject({
      method: 'POST',
      url: `/deployments/${D1}/comfyui/install`,
      payload: { accelerator: 'tpu' },
    });
    expect(res.statusCode).toBe(400);
    expect(installComfy).not.toHaveBeenCalled();
  });

  it('refuses an unknown power action rather than forwarding it', async () => {
    const power = vi.fn();
    const app = await server(ADMIN, { rows: [row()], agent: fakeAgent({ power }) });
    const res = await app.inject({ method: 'POST', url: `/deployments/${D1}/comfyui/format` });
    expect(res.statusCode).toBe(404);
    expect(power).not.toHaveBeenCalled();
  });

  it('registers the ComfyUI as a backend built from what the agent said', async () => {
    const rows = [row()];
    const backends: { id: string; name: string; base_url: string }[] = [];
    const app = await server(ADMIN, { rows, backends });
    const res = await app.inject({ method: 'POST', url: `/deployments/${D1}/backend` });
    expect(res.statusCode).toBe(201);
    expect(res.json().adopted).toBe(false);
    expect(backends[0].base_url).toBe('http://192.168.1.50:8188');
    expect(rows[0].backend_id).toBe(backends[0].id);
  });

  it('adopts a backend somebody already added by hand', async () => {
    const rows = [row()];
    const backends = [{ id: 'existing', name: 'desktop', base_url: 'http://192.168.1.50:8188' }];
    const app = await server(ADMIN, { rows, backends });
    const res = await app.inject({ method: 'POST', url: `/deployments/${D1}/backend` });
    expect(res.statusCode).toBe(200);
    expect(res.json().adopted).toBe(true);
    expect(backends).toHaveLength(1);
    expect(rows[0].backend_id).toBe('existing');
  });

  it('will not register twice', async () => {
    const rows = [row({ backend_id: 'existing', backend_name: 'desktop' })];
    const app = await server(ADMIN, { rows });
    const res = await app.inject({ method: 'POST', url: `/deployments/${D1}/backend` });
    expect(res.statusCode).toBe(409);
  });

  it('removes the deployment without touching its backend', async () => {
    const rows = [row({ backend_id: 'existing' })];
    const backends = [{ id: 'existing', name: 'desktop', base_url: 'http://192.168.1.50:8188' }];
    const app = await server(ADMIN, { rows, backends });
    expect((await app.inject({ method: 'DELETE', url: `/deployments/${D1}` })).statusCode).toBe(204);
    expect(rows).toHaveLength(0);
    expect(backends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- scripts

describe('the generated installers', () => {
  const params = {
    serverUrl: 'http://192.168.1.9:4000',
    code: "K7QM4XTB",
    comfyPort: 8188,
  };

  it('quotes a value safely for sh', () => {
    const script = bashInstaller({ ...params, code: "K7QM'XTB" });
    // A naive interpolation would end the string here and run the rest.
    expect(script).toContain(`CODE='K7QM'\\''XTB'`);
    expect(script).not.toContain(`CODE='K7QM'XTB'`);
  });

  it('quotes a value safely for PowerShell', () => {
    const script = powershellInstaller({ ...params, code: "K7QM'XTB" });
    expect(script).toContain(`$Code   = 'K7QM''XTB'`);
  });

  it('downloads a generic binary, with no deployment and no token in the URL', () => {
    // The retired scheme put both in the download URL, which meant a script
    // could not be shared and a leaked one leaked a long-lived credential.
    for (const script of [bashInstaller(params), powershellInstaller(params)]) {
      expect(script).toContain('/api/deployments/agent/');
      expect(script).not.toContain('token');
      expect(script).not.toContain('setup');
    }
  });

  it('hands the agent an address and a code, and lets it do the install', () => {
    const bash = bashInstaller(params);
    // exec, so the agent's own exit code is the script's, and its error
    // messages are what an operator sees rather than a wrapper's.
    expect(bash).toContain('exec "$BINARY" install --server "$SERVER" --code "$CODE"');

    const ps = powershellInstaller(params);
    expect(ps).toContain('& $Binary install --server $Server --code $Code');
  });

  it('does nothing but download the binary and run it', () => {
    // The whole point of the rewrite: the script no longer hunts for a Node
    // runtime, downloads six source files or writes a service unit. If any of
    // that comes back, it came back by accident.
    for (const script of [bashInstaller(params), powershellInstaller(params)]) {
      expect(script).not.toContain('node');
      expect(script).not.toContain('.mjs');
      expect(script).not.toContain('manifest');
    }
    // A bootstrap this small is one a person can read before running it, which
    // is the only defence a `curl | bash` line has.
    expect(bashInstaller(params).split('\n').length).toBeLessThan(70);
  });

  it('builds a one-liner per platform that carries the code as an argument', () => {
    expect(oneLiner('linux', params)).toContain('--code');
    expect(oneLiner('linux', params)).toContain('linux-amd64');
    expect(oneLiner('darwin', params)).toContain('macos-arm64');
    expect(oneLiner('win32', params)).toContain('windows-amd64');
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(oneLiner(platform, params)).toContain(params.code);
    }
  });

  it('picks the right macOS binary, because a Mac is genuinely still split', () => {
    const script = bashInstaller(params);
    expect(script).toContain('uname -m');
    expect(script).toContain('macos-arm64');
    expect(script).toContain('macos-amd64');
    // Everything else we ship is x86-64, so there is nothing to decide there.
    expect(script).toContain('TARGET="linux-amd64"');
  });

  it('downloads into a temporary folder rather than wherever it was run', () => {
    // This gets run from an SSH session's home directory, or from a read-only
    // share; neither should end up with a stray 7 MB binary in it.
    expect(bashInstaller(params)).toContain('mktemp -d');
    expect(powershellInstaller(params)).toContain('GetTempPath()');
  });

  it('turns on TLS 1.2 before PowerShell 5 tries an https download', () => {
    // Windows PowerShell 5 still defaults to TLS 1.0, which nothing accepts.
    // A rippel behind https would otherwise fail with a closed connection.
    expect(powershellInstaller(params)).toContain('Tls12');
  });

  it('says it needs no administrator, because that was the failure', () => {
    expect(powershellInstaller(params)).toContain('needs no administrator');
  });
});

// ---------------------------------------------------------------- releases

describe('the agent release lookup', () => {
  it('still produces working links when GitHub cannot be reached', async () => {
    clearReleaseCache();
    const release = await latestAgentRelease(
      (async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      }) as unknown as typeof fetch,
      'frogg-app/rippel',
    );
    expect(release.tag).toBeNull();
    expect(release.note).toContain('Could not reach GitHub');
    // Four: a Mac is genuinely split between Apple silicon and Intel, and one
    // binary cannot serve both.
    expect(release.downloads).toHaveLength(4);
    for (const download of release.downloads) {
      expect(download.url).toContain('/releases/latest/download/');
    }
  });

  it('uses the real asset URLs when it can', async () => {
    clearReleaseCache();
    const release = await latestAgentRelease(
      (async () =>
        new Response(
          JSON.stringify({
            tag_name: 'agent-v0.1.0',
            name: 'agent 0.1.0',
            published_at: '2026-09-01T00:00:00Z',
            html_url: 'https://github.com/frogg-app/rippel/releases/tag/agent-v0.1.0',
            assets: [
              {
                name: 'rippel-agent-linux-amd64',
                browser_download_url: 'https://example.test/rippel-agent-linux-amd64',
                size: 7_372_960,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
      'frogg-app/rippel',
    );
    expect(release.tag).toBe('agent-v0.1.0');
    const linux = release.downloads.find((d) => d.platform === 'linux')!;
    expect(linux.url).toBe('https://example.test/rippel-agent-linux-amd64');
    expect(linux.sizeBytes).toBe(7_372_960);
    // Windows and macOS have no asset in this release, so they fall back to the
    // /latest/download link rather than disappearing from the page.
    expect(release.downloads.find((d) => d.platform === 'win32')!.url).toContain('/latest/download/');
    clearReleaseCache();
  });

  it('names the same assets the build script produces', () => {
    // A renamed binary must not end up with a working download on one side and
    // a dead link on the other.
    expect(AGENT_BINARIES.map((b) => b.asset)).toEqual([
      'rippel-agent-windows-amd64.exe',
      'rippel-agent-macos-arm64',
      'rippel-agent-macos-amd64',
      'rippel-agent-linux-amd64',
    ]);
  });
});

// ---------------------------------------------------------- memory profiles

describe('setting how much memory a machine may use', () => {
  it('stores the intent, pushes the flags, and restarts ComfyUI', async () => {
    // ComfyUI reads its arguments at startup and nowhere else, so without the
    // restart nothing has changed and the control only appears to have worked.
    const rows = [row()];
    const pushed: { comfyArgs?: string }[] = [];
    const powered: string[] = [];
    const app = await server(ADMIN, {
      rows,
      agent: fakeAgent({
        updateConfig: async (_target, patch) => {
          pushed.push(patch);
        },
        power: async (_target, action) => {
          powered.push(action);
          return {};
        },
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/deployments/${D1}/memory`,
      payload: { profile: 'low-vram', cpuVae: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ profile: 'low-vram', cpuVae: true, applied: true, restarted: true });
    expect(pushed).toEqual([{ comfyArgs: '--lowvram --cpu-vae' }]);
    expect(powered).toEqual(['restart']);
    expect(rows[0]!.memory_profile).toBe('low-vram');
    expect(rows[0]!.cpu_vae).toBe(true);
  });

  it('sends no flags at all for the fast profile', async () => {
    const pushed: { comfyArgs?: string }[] = [];
    const app = await server(ADMIN, {
      rows: [row()],
      agent: fakeAgent({
        updateConfig: async (_t, patch) => {
          pushed.push(patch);
        },
      }),
    });
    await app.inject({ method: 'POST', url: `/deployments/${D1}/memory`, payload: { profile: 'fast' } });
    expect(pushed).toEqual([{ comfyArgs: '' }]);
  });

  it('saves the choice even when the machine is asleep', async () => {
    // The case this is built for: you configure a machine while it is off, and
    // the panel must not silently forget what you chose.
    const rows = [row({ status: 'offline' })];
    const app = await server(ADMIN, {
      rows,
      agent: fakeAgent({
        updateConfig: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/deployments/${D1}/memory`,
      payload: { profile: 'minimal-vram' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: false, restarted: false });
    expect(res.json().message).toMatch(/did not answer/);
    // Saved regardless, so the next restart picks it up.
    expect(rows[0]!.memory_profile).toBe('minimal-vram');
  });

  it('does not restart a machine that has no ComfyUI running', async () => {
    const powered: string[] = [];
    const app = await server(ADMIN, {
      rows: [row({ comfy: { ...COMFY, running: false } })],
      agent: fakeAgent({
        power: async (_t, action) => {
          powered.push(action);
          return {};
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/deployments/${D1}/memory`,
      payload: { profile: 'balanced' },
    });
    expect(res.json().restarted).toBe(false);
    expect(powered).toEqual([]);
  });

  it('refuses a profile it does not know rather than writing it', async () => {
    const rows = [row()];
    const app = await server(ADMIN, { rows });
    const res = await app.inject({
      method: 'POST',
      url: `/deployments/${D1}/memory`,
      payload: { profile: '--rm -rf' },
    });
    expect(res.statusCode).toBe(400);
    expect(rows[0]!.memory_profile).toBe('balanced');
  });

  it('is admin-only', async () => {
    const app = await server(USER, { rows: [row()] });
    const res = await app.inject({
      method: 'POST',
      url: `/deployments/${D1}/memory`,
      payload: { profile: 'low-vram' },
    });
    expect(res.statusCode).toBe(403);
  });
});
