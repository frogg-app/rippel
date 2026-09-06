/**
 * Backend admin routes against an in-memory table and a scripted fetch: the
 * gating, the validation, the uniqueness rule, the busy refusal, and the
 * probe's three outcomes. No Postgres, no ComfyUI.
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  makeBackendAdminRoutes,
  normaliseBaseUrl,
  probeBackend,
  type AdminDb,
} from './admin.js';

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' as const };
const USER = { id: '22222222-2222-4222-8222-222222222222', role: 'user' as const };
const B1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const B2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

interface Row {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  status: 'online' | 'offline' | 'unknown';
  vram_limit_mb: number | null;
}

function fakeDb(rows: Row[], busyIds: string[] = []): AdminDb {
  let next = 0;
  const full = (r: Row) => ({
    ...r,
    device_name: null,
    vram_free: null,
    vram_total: null,
    ram_free: null,
    ram_total: null,
    last_seen_at: null,
  });
  const query = (async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM backends WHERE lower(name)')) {
      const name = (params[0] as string).toLowerCase();
      const except = params[1] as string | undefined;
      return rows.filter((r) => r.name.toLowerCase() === name && r.id !== except).map((r) => ({ id: r.id }));
    }
    if (sql.startsWith('DELETE FROM backends')) {
      const i = rows.findIndex((r) => r.id === params[0]);
      if (i >= 0) rows.splice(i, 1);
      return [];
    }
    if (sql.includes('FROM backends WHERE id = $1') || sql.includes('FROM backends\n')) {
      return rows.filter((r) => r.id === params[0]).map(full);
    }
    if (sql.startsWith('INSERT INTO backends')) {
      const [name, base_url, enabled, vram_limit_mb] = params as [string, string, boolean, number | null];
      const row: Row = { id: [B1, B2, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'][next++] ?? `id-${next}`, name, base_url, enabled, status: 'unknown', vram_limit_mb };
      rows.push(row);
      return [full(row)];
    }
    if (sql.startsWith('UPDATE backends')) {
      const [id, name, base_url, enabled, setLimit, limit] = params as [string, string | null, string | null, boolean | null, boolean, number | null];
      const row = rows.find((r) => r.id === id)!;
      if (name !== null) row.name = name;
      if (base_url !== null && base_url !== row.base_url) {
        row.base_url = base_url;
        row.status = 'unknown';
      }
      if (enabled !== null) row.enabled = enabled;
      if (setLimit) row.vram_limit_mb = limit;
      return [full(row)];
    }
    if (sql.includes('FROM jobs')) {
      return [{ n: String(busyIds.includes(params[0] as string) ? 1 : 0) }];
    }
    if (sql.startsWith('DELETE FROM backends')) {
      const i = rows.findIndex((r) => r.id === params[0]);
      if (i >= 0) rows.splice(i, 1);
      return [];
    }
    throw new Error(`fake db: unexpected query ${sql}`);
  }) as AdminDb['query'];
  return { query, queryOne: (async (sql, params) => (await query(sql, params))[0] ?? null) as AdminDb['queryOne'] };
}

const okStats = () =>
  new Response(
    JSON.stringify({
      system: { comfyui_version: '0.34.0' },
      devices: [{ name: 'cuda:0 AMD Radeon RX 6900 XT', type: 'cuda', vram_total: 17_000_000_000 }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

async function server(user: { id: string; role: 'admin' | 'user' } | null, opts: { rows?: Row[]; busy?: string[]; fetch?: typeof fetch } = {}) {
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
  const rows = opts.rows ?? [
    { id: B1, name: 'desktop', base_url: 'http://gpu:8188', enabled: true, status: 'online', vram_limit_mb: null },
  ];
  const polled: string[] = [];
  await app.register(
    makeBackendAdminRoutes({
      db: fakeDb(rows, opts.busy),
      fetch: opts.fetch ?? (async () => okStats()),
      pollNow: async (id) => {
        polled.push(id);
      },
      probeTimeoutMs: 200,
    }),
  );
  return { app, rows, polled };
}

describe('gating', () => {
  it('is admin only, on every route', async () => {
    const { app } = await server(USER);
    expect((await app.inject({ method: 'POST', url: '/backends', payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/backends/${B1}`, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/backends/${B1}` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/backends/${B1}/probe` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/backends/probe', payload: { baseUrl: 'http://x' } })).statusCode).toBe(403);
    const anon = await server(null);
    expect((await anon.app.inject({ method: 'POST', url: '/backends', payload: {} })).statusCode).toBe(401);
  });
});

describe('create', () => {
  it('validates the name and the address', async () => {
    const { app } = await server(ADMIN);
    const noName = await app.inject({ method: 'POST', url: '/backends', payload: { baseUrl: 'http://gpu2:8188' } });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().field).toBe('name');
    for (const baseUrl of ['gpu2:8188', 'ftp://gpu2', 'http://gpu2:8188/api', 'http://gpu2:8188/?x=1', '']) {
      const bad = await app.inject({ method: 'POST', url: '/backends', payload: { name: 'second', baseUrl } });
      expect(bad.statusCode, baseUrl).toBe(400);
      expect(bad.json().field).toBe('baseUrl');
    }
  });

  it('refuses a duplicate name, case-insensitively', async () => {
    const { app } = await server(ADMIN);
    const dup = await app.inject({ method: 'POST', url: '/backends', payload: { name: 'Desktop', baseUrl: 'http://gpu2:8188' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('conflict');
  });

  it('creates, normalises the address, and asks for an immediate poll', async () => {
    const { app, rows, polled } = await server(ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: '/backends',
      payload: { name: '  laptop ', baseUrl: 'http://192.168.1.20:8188/', vramLimitMb: 8192 },
    });
    expect(res.statusCode).toBe(201);
    const backend = res.json().backend;
    expect(backend).toMatchObject({ name: 'laptop', baseUrl: 'http://192.168.1.20:8188', enabled: true, status: 'unknown', vramLimitMb: 8192 });
    expect(rows).toHaveLength(2);
    expect(polled).toEqual([backend.id]);
  });
});

describe('edit', () => {
  it('patches only what was sent, and clears a limit with null', async () => {
    const { app, rows, polled } = await server(ADMIN, {
      rows: [{ id: B1, name: 'desktop', base_url: 'http://gpu:8188', enabled: true, status: 'online', vram_limit_mb: 4096 }],
    });
    const res = await app.inject({ method: 'PATCH', url: `/backends/${B1}`, payload: { enabled: false, vramLimitMb: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().backend).toMatchObject({ name: 'desktop', enabled: false, vramLimitMb: null, status: 'online' });
    expect(rows[0]!.base_url).toBe('http://gpu:8188');
    expect(polled).toEqual([B1]);
  });

  it('resets status to unknown when the address changes', async () => {
    const { app } = await server(ADMIN);
    const res = await app.inject({ method: 'PATCH', url: `/backends/${B1}`, payload: { baseUrl: 'http://elsewhere:8188' } });
    expect(res.json().backend).toMatchObject({ baseUrl: 'http://elsewhere:8188', status: 'unknown' });
  });

  it('400s an empty patch, 404s an unknown id, 409s a stolen name', async () => {
    const { app } = await server(ADMIN, {
      rows: [
        { id: B1, name: 'desktop', base_url: 'http://gpu:8188', enabled: true, status: 'online', vram_limit_mb: null },
        { id: B2, name: 'laptop', base_url: 'http://gpu2:8188', enabled: true, status: 'online', vram_limit_mb: null },
      ],
    });
    expect((await app.inject({ method: 'PATCH', url: `/backends/${B1}`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/backends/${ADMIN.id}`, payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/backends/${B1}`, payload: { name: 'LAPTOP' } })).statusCode).toBe(409);
    // Renaming to its own name in another case is not a conflict.
    expect((await app.inject({ method: 'PATCH', url: `/backends/${B1}`, payload: { name: 'Desktop' } })).statusCode).toBe(200);
  });
});

describe('remove', () => {
  it('deletes an idle backend and refuses a busy one', async () => {
    const idle = await server(ADMIN);
    expect((await idle.app.inject({ method: 'DELETE', url: `/backends/${B1}` })).statusCode).toBe(204);
    expect(idle.rows).toHaveLength(0);

    const busy = await server(ADMIN, { busy: [B1] });
    const res = await busy.app.inject({ method: 'DELETE', url: `/backends/${B1}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('busy');
    expect(busy.rows).toHaveLength(1);
  });
});

describe('probe', () => {
  it('reports version, device and latency on success', async () => {
    const { app } = await server(ADMIN);
    const res = await app.inject({ method: 'POST', url: `/backends/${B1}/probe` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, version: '0.34.0', device: 'cuda:0 AMD Radeon RX 6900 XT', vramTotal: 17_000_000_000 });
    expect(typeof res.json().latencyMs).toBe('number');
  });

  it('tests an address before it is saved, and validates it', async () => {
    const { app } = await server(ADMIN);
    const ok = await app.inject({ method: 'POST', url: '/backends/probe', payload: { baseUrl: 'http://new:8188' } });
    expect(ok.json().ok).toBe(true);
    const bad = await app.inject({ method: 'POST', url: '/backends/probe', payload: { baseUrl: 'new:8188' } });
    expect(bad.statusCode).toBe(400);
  });

  it('turns a refused connection and a non-ComfyUI answer into ok:false with a reason', async () => {
    const refused = await probeBackend('http://nowhere:1', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('ECONNREFUSED');

    const wrong = await probeBackend('http://web:80', async () => new Response('<html>', { status: 404 }));
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('404');

    const slow = await probeBackend(
      'http://slow:8188',
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      30,
    );
    expect(slow.ok).toBe(false);
    expect(slow.error).toMatch(/no answer/i);
  });
});

describe('normaliseBaseUrl', () => {
  it('accepts an origin and strips a trailing slash', () => {
    expect(normaliseBaseUrl(' http://192.168.1.10:8188/ ')).toBe('http://192.168.1.10:8188');
    expect(normaliseBaseUrl('https://gpu.local')).toBe('https://gpu.local');
    expect(normaliseBaseUrl('http://gpu:8188/prompt')).toBeNull();
    expect(normaliseBaseUrl(42)).toBeNull();
  });
});
