/**
 * Backend storage: the path parsing that attributes a file to a person, the
 * lazy hash backfill, and the routes' gating — all against a scripted helper
 * and an in-memory table, so nothing here needs Postgres or a ComfyUI box.
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { StorageDriver } from '../storage/driver.js';
import { contentHash } from '../workflows/init-image.js';
import {
  attributeInputs,
  attributeOutputs,
  HelperError,
  makeStorageHelper,
  makeStorageRoutes,
  parseInputHash,
  parseOutputPath,
  type HelperFile,
  type StorageDb,
  type StorageHelper,
} from './storage.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BACKEND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const users = {
  [ALICE]: { email: 'alice@example.com', display_name: 'Alice' },
  [BOB]: { email: 'bob@example.com', display_name: null },
};

interface Tables {
  jobs: Array<{ id: string; user_id: string }>;
  assets: Array<{
    id: string;
    job_id: string | null;
    user_id: string;
    source_filename: string | null;
    storage_key: string;
    content_hash: string | null;
  }>;
  uploads: Array<{ id: string; user_id: string; storage_key: string; content_hash: string | null }>;
}

/**
 * Just enough SQL to serve the module's five queries. Matching on a fragment
 * of the statement keeps the fake honest about *which* query ran.
 */
function fakeDb(t: Tables): StorageDb {
  const withUser = <R extends { user_id: string }>(row: R) => ({
    ...row,
    email: users[row.user_id as keyof typeof users].email,
    display_name: users[row.user_id as keyof typeof users].display_name,
  });
  const query = (async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM jobs j')) {
      const ids = params[0] as string[];
      return t.jobs.filter((j) => ids.includes(j.id)).map(withUser);
    }
    if (sql.includes('FROM assets') && sql.includes('job_id = ANY')) {
      const ids = params[0] as string[];
      return t.assets.filter((a) => a.job_id && ids.includes(a.job_id) && a.source_filename);
    }
    if (sql.includes('FROM uploads p')) {
      const hashes = params[0] as string[];
      return t.uploads.filter((u) => u.content_hash && hashes.includes(u.content_hash)).map(withUser);
    }
    if (sql.includes('FROM assets a')) {
      const hashes = params[0] as string[];
      return t.assets.filter((a) => a.content_hash && hashes.includes(a.content_hash)).map(withUser);
    }
    if (sql.startsWith('SELECT id, storage_key FROM uploads')) {
      return t.uploads.filter((u) => u.content_hash === null);
    }
    if (sql.startsWith('SELECT id, storage_key FROM assets')) {
      return t.assets.filter((a) => a.content_hash === null);
    }
    if (sql.startsWith('UPDATE uploads')) {
      const [id, hash] = params as [string, string];
      t.uploads.find((u) => u.id === id)!.content_hash = hash;
      return [];
    }
    if (sql.startsWith('UPDATE assets')) {
      const [id, hash] = params as [string, string];
      t.assets.find((a) => a.id === id)!.content_hash = hash;
      return [];
    }
    if (sql.includes('FROM backends')) {
      return params[0] === BACKEND ? [{ id: BACKEND, name: 'desktop', base_url: 'http://gpu:8188' }] : [];
    }
    throw new Error(`fake db: unexpected query ${sql}`);
  }) as StorageDb['query'];
  return { query, queryOne: (async (sql, params) => (await query(sql, params))[0] ?? null) as StorageDb['queryOne'] };
}

function fakeDriver(objects: Record<string, Buffer>): StorageDriver {
  return {
    name: 'local',
    put: async () => {},
    get: async (key) => {
      const hit = objects[key];
      if (!hit) throw new Error(`missing ${key}`);
      return hit;
    },
    getStream: async () => {
      throw new Error('unused');
    },
    exists: async (key) => key in objects,
    delete: async () => {},
  };
}

const file = (path: string, size = 100): HelperFile => ({
  path,
  size,
  modifiedAt: '2026-09-06T10:00:00Z',
});

describe('path parsing', () => {
  it('reads the job id out of an output path and nothing else', () => {
    expect(parseOutputPath(`image/${JOB_A}/ComfyUI_00003_.png`)).toEqual({
      kind: 'image',
      jobId: JOB_A,
      file: 'ComfyUI_00003_.png',
    });
    expect(parseOutputPath(`VIDEO/${JOB_A.toUpperCase()}/clip.mp4`)?.jobId).toBe(JOB_A);
    expect(parseOutputPath('image/not-a-uuid/x.png')).toBeNull();
    expect(parseOutputPath(`image/${JOB_A}/nested/x.png`)).toBeNull();
    expect(parseOutputPath('stray.png')).toBeNull();
  });

  it('reads the content hash out of an input name', () => {
    const hash = 'a'.repeat(32);
    expect(parseInputHash(`${hash}.png`)).toBe(hash);
    expect(parseInputHash(`${hash.toUpperCase()}.JPG`)).toBe(hash);
    expect(parseInputHash('probe.png')).toBeNull();
    expect(parseInputHash(`sub/${hash}.png`)).toBeNull();
  });
});

describe('attribution', () => {
  it('gives an output to its job owner and links the persisted asset', async () => {
    const db = fakeDb({
      jobs: [
        { id: JOB_A, user_id: ALICE },
        { id: JOB_B, user_id: BOB },
      ],
      assets: [
        {
          id: 'asset-1',
          job_id: JOB_A,
          user_id: ALICE,
          source_filename: 'ComfyUI_00001_.png',
          storage_key: 'k1',
          content_hash: null,
        },
      ],
      uploads: [],
    });
    const out = await attributeOutputs(
      [
        file(`image/${JOB_A}/ComfyUI_00001_.png`),
        file(`image/${JOB_A}/ComfyUI_00002_.png`),
        file(`video/${JOB_B}/clip.mp4`),
        file('image/deleted-job-or-not-ours.png'),
      ],
      db,
    );
    expect(out[0]).toMatchObject({ owner: { id: ALICE, displayName: 'Alice' }, jobId: JOB_A, assetId: 'asset-1' });
    expect(out[1]).toMatchObject({ owner: { id: ALICE }, jobId: JOB_A });
    expect(out[1]!.assetId).toBeUndefined();
    expect(out[2]).toMatchObject({ owner: { id: BOB, displayName: null }, jobId: JOB_B });
    expect(out[3]!.owner).toBeNull();
  });

  it('matches an input by hash, backfilling old rows once', async () => {
    const bytes = Buffer.from('a starting image');
    const hash = contentHash(bytes);
    const tables: Tables = {
      jobs: [],
      assets: [],
      uploads: [{ id: 'up-1', user_id: BOB, storage_key: 'uploads/x.png', content_hash: null }],
    };
    const driver = fakeDriver({ 'uploads/x.png': bytes });
    const inputs = await attributeInputs([file(`${hash}.png`), file('probe.png')], fakeDb(tables), driver);

    expect(inputs[0]).toMatchObject({ owner: { id: BOB }, uploadId: 'up-1' });
    expect(inputs[1]!.owner).toBeNull();
    // Cached: the row now carries the hash, so the next visit reads nothing.
    expect(tables.uploads[0]!.content_hash).toBe(hash);
  });

  it('falls back to an asset that was used as a starting image', async () => {
    const bytes = Buffer.from('a library image');
    const hash = contentHash(bytes);
    const inputs = await attributeInputs(
      [file(`${hash}.png`)],
      fakeDb({
        jobs: [],
        assets: [
          { id: 'asset-9', job_id: null, user_id: ALICE, source_filename: null, storage_key: 'a', content_hash: hash },
        ],
        uploads: [],
      }),
      fakeDriver({}),
    );
    expect(inputs[0]).toMatchObject({ owner: { id: ALICE }, assetId: 'asset-9' });
  });
});

describe('helper client', () => {
  const responses = (status: number, body: unknown = {}) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('maps the helper’s answers onto the four states', async () => {
    expect(await makeStorageHelper({ token: 't', fetchImpl: responses(200, { ok: true }) }).probe('http://x')).toEqual({ state: 'ok' });
    expect(await makeStorageHelper({ token: 't', fetchImpl: responses(404) }).probe('http://x')).toEqual({ state: 'missing' });
    expect(await makeStorageHelper({ token: 't', fetchImpl: responses(401) }).probe('http://x')).toEqual({ state: 'unauthorised' });
    expect(await makeStorageHelper({ token: 't', fetchImpl: responses(503) }).probe('http://x')).toEqual({ state: 'unauthorised' });
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await makeStorageHelper({ token: 't', fetchImpl: down }).probe('http://x')).toEqual({ state: 'offline' });
  });

  it('sends the token and the delete body the helper expects', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ deleted: ['a.png'], missing: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const helper = makeStorageHelper({ token: 'secret', fetchImpl });
    const result = await helper.remove('http://gpu:8188/', 'input', ['a.png']);
    expect(result).toEqual({ deleted: ['a.png'], missing: [] });
    expect(seen[0]!.url).toBe('http://gpu:8188/rippel/storage/files');
    expect((seen[0]!.init.headers as Record<string, string>)['X-Rippel-Token']).toBe('secret');
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ type: 'input', paths: ['a.png'] });
  });
});

describe('routes', () => {
  type User = { id: string; role: 'user' | 'admin' } | null;

  function scriptedHelper(state: 'ok' | 'missing' = 'ok'): StorageHelper & { removed: string[][] } {
    const removed: string[][] = [];
    return {
      removed,
      probe: async () => ({ state }),
      list: async (_url, folder) => ({
        root: `C:\\ComfyUI\\${folder}\\comfy-studio`,
        files: folder === 'output' ? [file(`image/${JOB_A}/ComfyUI_00001_.png`, 2048)] : [file('probe.png', 10)],
        totalBytes: folder === 'output' ? 2048 : 10,
      }),
      remove: async (_url, _folder, paths) => {
        removed.push(paths);
        if (paths.includes('../escape.png')) throw new HelperError('offline', 'refused');
        return { deleted: paths, missing: [] };
      },
    };
  }

  async function server(as: User, helper = scriptedHelper()) {
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (req) => {
      req.user = as as never;
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
    const db = fakeDb({ jobs: [{ id: JOB_A, user_id: ALICE }], assets: [], uploads: [] });
    await app.register(makeStorageRoutes({ db, helper, driver: () => fakeDriver({}) }));
    return { app, helper };
  }

  it('is admin only', async () => {
    const { app } = await server({ id: ALICE, role: 'user' });
    expect((await app.inject({ method: 'GET', url: `/backends/${BACKEND}/storage` })).statusCode).toBe(403);
    const anon = await server(null);
    expect((await anon.app.inject({ method: 'GET', url: `/backends/${BACKEND}/storage` })).statusCode).toBe(401);
  });

  it('lists both folders with owners attached', async () => {
    const { app } = await server({ id: ALICE, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: `/backends/${BACKEND}/storage` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.helper).toBe('ok');
    expect(body.output.totalBytes).toBe(2048);
    expect(body.output.files[0]).toMatchObject({ owner: { id: ALICE }, jobId: JOB_A });
    expect(body.input.files[0].owner).toBeNull();
  });

  it('reports a missing helper as a state, not an error', async () => {
    const { app } = await server({ id: ALICE, role: 'admin' }, scriptedHelper('missing'));
    const res = await app.inject({ method: 'GET', url: `/backends/${BACKEND}/storage` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ helper: 'missing', input: { totalBytes: 0, files: [] }, output: { totalBytes: 0, files: [] } });
  });

  it('404s an unknown backend', async () => {
    const { app } = await server({ id: ALICE, role: 'admin' });
    expect((await app.inject({ method: 'GET', url: `/backends/${JOB_B}/storage` })).statusCode).toBe(404);
  });

  it('validates a delete and passes it through', async () => {
    const { app, helper } = await server({ id: ALICE, role: 'admin' });
    const bad = await app.inject({ method: 'DELETE', url: `/backends/${BACKEND}/storage`, payload: { type: 'temp', paths: ['x'] } });
    expect(bad.statusCode).toBe(400);
    const empty = await app.inject({ method: 'DELETE', url: `/backends/${BACKEND}/storage`, payload: { type: 'input', paths: [] } });
    expect(empty.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'DELETE',
      url: `/backends/${BACKEND}/storage`,
      payload: { type: 'output', paths: [`image/${JOB_A}/ComfyUI_00001_.png`] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ deleted: [`image/${JOB_A}/ComfyUI_00001_.png`], missing: [] });
    expect(helper.removed).toEqual([[`image/${JOB_A}/ComfyUI_00001_.png`]]);

    const down = await app.inject({ method: 'DELETE', url: `/backends/${BACKEND}/storage`, payload: { type: 'input', paths: ['../escape.png'] } });
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toBe('helper_offline');
  });
});


describe('model deletion through the helper', () => {
  it('sends the folder and filename, and tells a missing file from a missing helper', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (String(init.body).includes('gone.safetensors')) {
        return new Response(JSON.stringify({ error: 'not_found', message: 'nope' }), { status: 404 });
      }
      if (String(init.body).includes('nohelper')) return new Response('', { status: 404 });
      return new Response(JSON.stringify({ deleted: true, path: 'C:/models/a.safetensors' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const helper = makeStorageHelper({ token: 'secret', fetchImpl });

    const ok = await helper.removeModel('http://gpu:8188', 'checkpoints', 'a.safetensors');
    expect(ok.deleted).toBe(true);
    expect(seen[0]!.url).toBe('http://gpu:8188/rippel/storage/models');
    expect(seen[0]!.init.method).toBe('DELETE');
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      folder: 'checkpoints',
      filename: 'a.safetensors',
    });

    await expect(
      helper.removeModel('http://gpu:8188', 'checkpoints', 'gone.safetensors'),
    ).rejects.toMatchObject({ state: 'not-found' });
    await expect(
      helper.removeModel('http://gpu:8188', 'checkpoints', 'nohelper.safetensors'),
    ).rejects.toMatchObject({ state: 'missing' });
  });
});
