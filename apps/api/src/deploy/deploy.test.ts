/**
 * The deployment routes against an in-memory table and a scripted agent: the
 * gating, the two authentications, the check-in that corrects a row, the
 * refusals, and the scripts. No Postgres, no SSH, no agent.
 *
 * The two authentications are the point of most of this. An administrator has
 * a session and no token; an agent has a token and no session. Confusing them
 * either way is the failure that matters — an admin route reachable by token
 * would let a GPU box read the fleet, and a token route behind requireAdmin
 * would mean no agent could ever check in.
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTask, ComfyState } from '@comfy/shared';
import { makeDeploymentRoutes, normaliseHost, type DeployDb } from './routes.js';
import { bashInstaller, oneLiner, powershellInstaller } from './scripts.js';
import { clearReleaseCache, latestAgentRelease } from './releases.js';
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
  last_seen_at: Date | null;
  created_at: Date;
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
    last_seen_at: new Date(),
    created_at: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

function fakeDb(rows: Row[], backends: { id: string; name: string; base_url: string }[] = []): DeployDb {
  let next = 0;
  const query = (async (sql: string, params: unknown[] = []) => {
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
    ...over,
  };
}

async function server(
  user: { id: string; role: 'admin' | 'user' } | null,
  opts: {
    rows?: Row[];
    backends?: { id: string; name: string; base_url: string }[];
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
      db: fakeDb(opts.rows ?? [], opts.backends ?? []),
      agent: opts.agent ?? fakeAgent(),
      fetchImpl: opts.fetchImpl,
      pollNow: async () => {},
    }),
  );
  await app.ready();
  return app;
}

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

  it('serves the agent source only to a token holder', async () => {
    const app = await server(null, { rows: [row()] });
    expect((await app.inject({ method: 'GET', url: '/deployments/agent/manifest' })).statusCode).toBe(401);
    const ok = await app.inject({
      method: 'GET',
      url: '/deployments/agent/manifest',
      headers: { 'x-rippel-agent-token': 'tok-secret' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('main.mjs');

    const file = await app.inject({
      method: 'GET',
      url: '/deployments/agent/file/main.mjs?token=tok-secret',
    });
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('rippel agent');

    const missing = await app.inject({
      method: 'GET',
      url: '/deployments/agent/file/nope.mjs?token=tok-secret',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('will not hand one deployment’s script to another’s token', async () => {
    const app = await server(null, { rows: [row(), row({ id: 'other', name: 'other', token: 'tok-other' })] });
    const res = await app.inject({ method: 'GET', url: `/deployments/${D1}/install.sh?token=tok-other` });
    expect(res.statusCode).toBe(401);
  });

  it('serves the installer to the right token', async () => {
    const app = await server(null, { rows: [row()] });
    const sh = await app.inject({ method: 'GET', url: `/deployments/${D1}/install.sh?token=tok-secret` });
    expect(sh.statusCode).toBe(200);
    expect(sh.body).toContain('TOKEN=');
    expect(sh.body).toContain('rippel-agent.service');

    const ps1 = await app.inject({ method: 'GET', url: `/deployments/${D1}/install.ps1?token=tok-secret` });
    expect(ps1.statusCode).toBe(200);
    expect(ps1.body).toContain('Register-ScheduledTask');
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
    deploymentId: D1,
    token: "tok'with-quote",
    agentPort: 8189,
    comfyPort: 8188,
  };

  it('quotes a token safely for sh', () => {
    const script = bashInstaller(params);
    // A naive interpolation would end the string here and run the rest.
    expect(script).toContain(`TOKEN='tok'\\''with-quote'`);
    expect(script).not.toContain(`TOKEN='tok'with-quote'`);
  });

  it('quotes a token safely for PowerShell', () => {
    const script = powershellInstaller(params);
    expect(script).toContain(`$Token      = 'tok''with-quote'`);
  });

  it('builds a one-liner per platform with the token escaped for a URL', () => {
    expect(oneLiner('linux', params)).toContain('curl -fsSL');
    expect(oneLiner('darwin', params)).toContain('install.sh');
    expect(oneLiner('win32', params)).toContain('install.ps1');
    expect(oneLiner('linux', params)).toContain(encodeURIComponent(params.token));
  });

  it('refuses to run on an old Node rather than failing later', () => {
    expect(bashInstaller(params)).toContain('NODE_MAJOR');
    expect(powershellInstaller(params)).toContain('Node.js 20 or newer is required');
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
    expect(release.downloads).toHaveLength(3);
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
                name: 'rippel-agent-linux.tar.gz',
                browser_download_url: 'https://example.test/linux.tar.gz',
                size: 40_960,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
      'frogg-app/rippel',
    );
    expect(release.tag).toBe('agent-v0.1.0');
    const linux = release.downloads.find((d) => d.platform === 'linux')!;
    expect(linux.url).toBe('https://example.test/linux.tar.gz');
    expect(linux.sizeBytes).toBe(40_960);
    // Windows and macOS have no asset in this release, so they fall back to the
    // /latest/download link rather than disappearing from the page.
    expect(release.downloads.find((d) => d.platform === 'win32')!.url).toContain('/latest/download/');
    clearReleaseCache();
  });
});
