/**
 * Unit tests for uploads.
 *
 * Same approach as `storage/storage.test.ts`: a temp directory for the driver
 * and an in-memory stand-in for the table, so nothing here needs Postgres or a
 * ComfyUI box. The size cap is additionally exercised through a real Fastify
 * instance, because that limit is enforced by the multipart *stream parser* and
 * a unit test of `storeUpload` would never reach the code that does it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '../env.js';
import { LocalStorageDriver } from '../storage/local.js';
import { setStorage } from '../storage/index.js';
import { resolveUploadForRead } from './access.js';
import { inspectUpload, storeUpload, UploadRejected, type UploadDb, type UploadRow } from './store.js';
import uploadRoutes from './routes.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'comfy-uploads-'));
});

afterEach(async () => {
  setStorage(null);
  await rm(root, { recursive: true, force: true });
});

function image(
  width: number,
  height: number,
  as: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff' = 'png',
): Promise<Buffer> {
  const img = sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  });
  switch (as) {
    case 'jpeg':
      return img.jpeg().toBuffer();
    case 'webp':
      return img.webp().toBuffer();
    case 'gif':
      return img.gif().toBuffer();
    case 'tiff':
      return img.tiff().toBuffer();
    default:
      return img.png().toBuffer();
  }
}

/** A stand-in for the `uploads` table. */
function fakeUploadsTable(seed: (UploadRow & Record<string, unknown>)[] = []): {
  db: UploadDb;
  rows: (UploadRow & Record<string, unknown>)[];
} {
  const rows = [...seed];

  const run = (sql: string, params: unknown[] = []): Record<string, unknown>[] => {
    const text = sql.trimStart();
    if (text.startsWith('SELECT')) {
      const [id, userId] = params as [string, string];
      const hit = rows.find((r) => r.id === id && r.user_id === userId);
      return hit ? [hit] : [];
    }
    if (text.startsWith('INSERT')) {
      const [userId, storageKey, thumbKey, mimeType, width, height, sizeBytes] = params as [
        string,
        string,
        string | null,
        string,
        number,
        number,
        number,
      ];
      const row = {
        id: `upload-${rows.length + 1}`,
        user_id: userId,
        storage_key: storageKey,
        thumb_key: thumbKey,
        mime_type: mimeType,
        width,
        height,
        size_bytes: sizeBytes,
        created_at: new Date('2026-09-06T12:00:00Z'),
      };
      rows.push(row);
      return [row];
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  };

  return {
    rows,
    db: {
      query: (async (sql: string, p?: unknown[]) => run(sql, p)) as UploadDb['query'],
      queryOne: (async (sql: string, p?: unknown[]) => run(sql, p)[0] ?? null) as UploadDb['queryOne'],
    },
  };
}

// ---------------------------------------------------------------- validation

describe('upload validation', () => {
  it('accepts the formats we can process, reporting real dimensions', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const info = await inspectUpload(await image(300, 200, format));
      expect(info.format, format).toBe(format);
      expect(info.width).toBe(300);
      expect(info.height).toBe(200);
    }
  });

  it('rejects a non-image whatever it is named or labelled', async () => {
    // The whole point: a text file called kitten.png with content-type
    // image/png. Neither the extension nor the header is consulted — the bytes
    // simply do not decode.
    const notAnImage = Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8');
    await expect(inspectUpload(notAnImage)).rejects.toBeInstanceOf(UploadRejected);
    await expect(inspectUpload(notAnImage)).rejects.toMatchObject({ code: 'unsupported_type' });
  });

  it('rejects an image whose header is a lie', async () => {
    // A real PNG signature followed by rubbish: passes any sniff that only
    // looks at magic bytes, fails a decode.
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512, 0x41),
    ]);
    await expect(inspectUpload(fake)).rejects.toMatchObject({ code: 'unsupported_type' });
  });

  it('rejects image formats outside the allowlist', async () => {
    for (const format of ['gif', 'tiff'] as const) {
      await expect(inspectUpload(await image(64, 64, format)), format).rejects.toMatchObject({
        code: 'unsupported_type',
      });
    }
    // An SVG is markup sharp is willing to rasterise; it must never count as an
    // uploaded image.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
    await expect(inspectUpload(svg)).rejects.toMatchObject({ code: 'unsupported_type' });
  });

  it('rejects an empty file', async () => {
    await expect(inspectUpload(Buffer.alloc(0))).rejects.toMatchObject({ code: 'empty' });
  });

  it('enforces the byte cap', async () => {
    const bytes = await image(600, 600);
    await expect(inspectUpload(bytes, { maxBytes: bytes.byteLength - 1 })).rejects.toMatchObject({
      code: 'too_large',
    });
    // The boundary itself is allowed.
    await expect(inspectUpload(bytes, { maxBytes: bytes.byteLength })).resolves.toMatchObject({
      format: 'png',
    });
  });

  it('enforces the megapixel cap, so a small file cannot decode to a huge one', async () => {
    // 4000x4000 of flat colour is a tiny PNG and 16 megapixels of RGBA.
    const bomb = await image(4000, 4000);
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    await expect(
      inspectUpload(bomb, { maxBytes: 10 * 1024 * 1024, maxMegapixels: 4 }),
    ).rejects.toMatchObject({
      code: 'too_many_pixels',
    });
  });
});

// ---------------------------------------------------------------- storing

describe('storeUpload', () => {
  it('stores the image and a thumbnail under the owner, and records both', async () => {
    const driver = new LocalStorageDriver(root);
    const { db, rows } = fakeUploadsTable();
    const bytes = await image(1200, 800, 'jpeg');

    const upload = await storeUpload({ userId: ALICE, bytes, driver, db });

    expect(upload.userId).toBe(ALICE);
    expect(upload.width).toBe(1200);
    expect(upload.height).toBe(800);
    expect(upload.mimeType).toBe('image/jpeg');
    expect(upload.url).toBe(`/api/uploads/${upload.id}`);
    expect(upload.thumbUrl).toBe(`/api/uploads/${upload.id}/thumb`);

    const row = rows[0]!;
    expect(row.storage_key.startsWith(`u/${ALICE}/`)).toBe(true);
    expect(row.storage_key.endsWith('.jpg')).toBe(true);
    expect(row.thumb_key).toMatch(/_thumb\.webp$/);
    expect(Number(row.size_bytes)).toBe(bytes.byteLength);

    // Both objects are really there, and the thumbnail is bounded.
    expect(await driver.exists(row.storage_key)).toBe(true);
    const thumb = await sharp(await driver.get(row.thumb_key!)).metadata();
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(512);
  });

  it('never writes anything for a file it rejects', async () => {
    const driver = new LocalStorageDriver(root);
    const { db, rows } = fakeUploadsTable();
    await expect(
      storeUpload({ userId: ALICE, bytes: Buffer.from('not an image'), driver, db }),
    ).rejects.toBeInstanceOf(UploadRejected);
    expect(rows).toHaveLength(0);
  });

  it('honours a per-call size cap', async () => {
    const driver = new LocalStorageDriver(root);
    const { db, rows } = fakeUploadsTable();
    const bytes = await image(400, 400);
    await expect(
      storeUpload({ userId: ALICE, bytes, driver, db, maxBytes: 16 }),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(rows).toHaveLength(0);
  });

  it('gives two drops of the same picture separate keys', async () => {
    const driver = new LocalStorageDriver(root);
    const { db, rows } = fakeUploadsTable();
    const bytes = await image(64, 64);
    await storeUpload({ userId: ALICE, bytes, driver, db });
    await storeUpload({ userId: ALICE, bytes, driver, db });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.storage_key).not.toBe(rows[1]!.storage_key);
  });
});

// ---------------------------------------------------------------- ownership

describe('upload read ownership', () => {
  const key = `u/${ALICE}/2026/09/${'a'.repeat(32)}.png`;
  const thumbKey = `u/${ALICE}/2026/09/${'b'.repeat(32)}_thumb.webp`;
  const id = 'upload-1';

  const table = () =>
    fakeUploadsTable([
      {
        id,
        user_id: ALICE,
        storage_key: key,
        thumb_key: thumbKey,
        mime_type: 'image/png',
        width: 10,
        height: 10,
        size_bytes: 100,
        created_at: new Date(),
      },
    ]).db;

  it('lets the owner read their own upload', async () => {
    expect(await resolveUploadForRead(table(), id, ALICE, 'full')).toMatchObject({
      ok: true,
      key,
      contentType: 'image/png',
      isThumb: false,
    });
  });

  it('serves the thumbnail key for the thumb variant', async () => {
    expect(await resolveUploadForRead(table(), id, ALICE, 'thumb')).toMatchObject({
      ok: true,
      key: thumbKey,
      contentType: 'image/webp',
      isThumb: true,
    });
  });

  it('refuses another user, indistinguishably from a missing upload', async () => {
    const asBob = await resolveUploadForRead(table(), id, BOB, 'full');
    const missing = await resolveUploadForRead(table(), 'upload-nope', ALICE, 'full');
    expect(asBob).toEqual({ ok: false, reason: 'not_found' });
    expect(missing).toEqual(asBob);
  });

  it('refuses a row whose key is outside the owner namespace', async () => {
    const { db } = fakeUploadsTable([
      {
        id,
        user_id: ALICE,
        storage_key: `u/${BOB}/2026/09/x.png`,
        thumb_key: null,
        mime_type: 'image/png',
        width: 10,
        height: 10,
        size_bytes: 100,
        created_at: new Date(),
      },
    ]);
    expect(await resolveUploadForRead(db, id, ALICE, 'full')).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });
  });

  it('falls back to the full image when there is no thumbnail', async () => {
    const { db } = fakeUploadsTable([
      {
        id,
        user_id: ALICE,
        storage_key: key,
        thumb_key: null,
        mime_type: 'image/png',
        width: 10,
        height: 10,
        size_bytes: 100,
        created_at: new Date(),
      },
    ]);
    expect(await resolveUploadForRead(db, id, ALICE, 'thumb')).toMatchObject({
      ok: true,
      key,
      isThumb: false,
    });
  });
});

// ---------------------------------------------------------------- the route

/**
 * The multipart body, hand-built. `form-data` is not a dependency and this is
 * ten lines; it also keeps the test honest about what the wire looks like.
 */
function multipartBody(opts: {
  fieldname: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}): { body: Buffer; headers: Record<string, string> } {
  const boundary = '----comfytestboundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${opts.fieldname}"; filename="${opts.filename}"\r\n` +
      `Content-Type: ${opts.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, opts.bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function appWithUser(user: { id: string; role: 'user' | 'admin' } | null): Promise<FastifyInstance> {
  const app = Fastify();
  // Stand-in for plugins/auth.ts: the route only ever asks for `req.user` and
  // `app.requireAuth`, so faking those keeps this a test of the route.
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    (req as { user: unknown }).user = user;
  });
  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Sign in.' });
    }
  });
  await app.register(uploadRoutes);
  await app.ready();
  return app;
}

describe('POST /uploads', () => {
  it('refuses an anonymous request before reading a byte', async () => {
    const app = await appWithUser(null);
    const { body, headers } = multipartBody({
      fieldname: 'file',
      filename: 'x.png',
      contentType: 'image/png',
      bytes: await image(8, 8),
    });
    const res = await app.inject({ method: 'POST', url: '/uploads', payload: body, headers });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a file over the cap with 413, without buffering it', async () => {
    const app = await appWithUser({ id: ALICE, role: 'user' });
    // Incompressible noise past the configured cap; the stream parser aborts it.
    const huge = Buffer.alloc(env.uploads.maxBytes + 4096);
    for (let i = 0; i < huge.length; i += 1) huge[i] = (i * 31) & 0xff;
    const { body, headers } = multipartBody({
      fieldname: 'file',
      filename: 'huge.png',
      contentType: 'image/png',
      bytes: huge,
    });
    const res = await app.inject({ method: 'POST', url: '/uploads', payload: body, headers });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'too_large' });
    await app.close();
  });

  it('rejects a renamed non-image with 400', async () => {
    setStorage(new LocalStorageDriver(root));
    const app = await appWithUser({ id: ALICE, role: 'user' });
    const { body, headers } = multipartBody({
      fieldname: 'file',
      filename: 'kitten.png',
      contentType: 'image/png',
      bytes: Buffer.from('I am a shell script, not a kitten.\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/uploads', payload: body, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'unsupported_type' });
    await app.close();
  });

  it('rejects a part sent under the wrong field name', async () => {
    const app = await appWithUser({ id: ALICE, role: 'user' });
    const { body, headers } = multipartBody({
      fieldname: 'image',
      filename: 'x.png',
      contentType: 'image/png',
      bytes: await image(8, 8),
    });
    const res = await app.inject({ method: 'POST', url: '/uploads', payload: body, headers });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a request that is not multipart at all', async () => {
    const app = await appWithUser({ id: ALICE, role: 'user' });
    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
