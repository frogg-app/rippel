/**
 * Turning a file the user dropped into a row in `uploads`.
 *
 * Deliberately the same shape as `storage/persist.ts` — bytes -> storage ->
 * thumbnail -> INSERT — and it reuses that module's storage driver, key builder
 * and sharp helpers rather than growing a second copy of any of them. The two
 * differ in exactly two ways, and both are why this is its own file:
 *
 *  - An upload is *untrusted input*. A finished generation comes from our own
 *    backend and is an image by construction; this comes off the internet with
 *    a filename and a content-type the sender chose. Neither is evidence. The
 *    only proof that a file is an image we can work with is that our own
 *    decoder reads it, so that is the check — see {@link inspectUpload}.
 *  - It lands in `uploads`, which has no job and therefore no
 *    (job_id, source_filename) idempotency key. Two drops of the same picture
 *    are two uploads; that is correct, because the user may well use them in
 *    different jobs and delete one.
 */

import type { Upload } from '@comfy/shared';
import { query as defaultQuery, queryOne as defaultQueryOne } from '../db.js';
import { env } from '../env.js';
import { buildKey, type StorageDriver } from '../storage/driver.js';
import { makeThumbnail, readImageInfo } from '../storage/images.js';
import { storage } from '../storage/index.js';

/** The database calls this module makes, as an interface, so tests can fake it. */
export interface UploadDb {
  query: typeof defaultQuery;
  queryOne: typeof defaultQueryOne;
}

const realDb: UploadDb = { query: defaultQuery, queryOne: defaultQueryOne };

export interface UploadRow {
  id: string;
  user_id: string;
  storage_key: string;
  thumb_key: string | null;
  mime_type: string;
  width: number;
  height: number;
  size_bytes: string | number | null;
  created_at: string | Date;
}

/**
 * Why the API refused a file. The route maps each to a status and a message the
 * user can act on: "that file isn't an image" is a different problem from
 * "that image is too big", and telling them apart is the whole value.
 */
export type UploadRejectionCode = 'empty' | 'too_large' | 'unsupported_type' | 'too_many_pixels';

export class UploadRejected extends Error {
  constructor(
    readonly code: UploadRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'UploadRejected';
  }
}

/**
 * The formats we accept.
 *
 * Narrower than what sharp can decode, on purpose. Each entry has to survive
 * the whole journey — decoded here, thumbnailed, handed back to a browser, and
 * eventually pushed to a ComfyUI box and opened by Pillow — and these three are
 * the ones every step of that chain handles without a plugin. The notable
 * omissions and their reasons:
 *
 *  - `svg`: sharp will happily rasterise one, which means accepting it is
 *    accepting arbitrary markup with remote references as an "image".
 *  - `gif`: an animated init image has no meaning, and taking frame 0 silently
 *    is worse than saying no.
 *  - `avif`, `heif`: browsers are fine, but Pillow needs `pillow-heif` on the
 *    backend and there is no way to know from here whether it is installed.
 *    A transcode on our side would fix this and can be added later.
 *  - `tiff`, `pdf`: not what anyone drags into a prompt box.
 *
 * Keyed by sharp's own `format` string, which is what the decode reports —
 * never the extension or the declared content-type.
 */
const ACCEPTED_FORMATS: Readonly<Record<string, { mimeType: string; extension: string }>> = {
  png: { mimeType: 'image/png', extension: 'png' },
  jpeg: { mimeType: 'image/jpeg', extension: 'jpg' },
  webp: { mimeType: 'image/webp', extension: 'webp' },
};

/** For an error message that names what we do take. */
export const ACCEPTED_UPLOAD_TYPES = Object.values(ACCEPTED_FORMATS).map((f) => f.mimeType);

export interface InspectedUpload {
  width: number;
  height: number;
  format: string;
  mimeType: string;
  extension: string;
}

/**
 * Decide whether these bytes are an image we will store, by decoding them.
 *
 * Order matters: size first (cheapest, and refuses to hand a huge buffer to the
 * decoder at all), then the header parse, then the format allowlist, then the
 * pixel count. Anything that throws out of sharp is a file that is not an image
 * in any format we have, however it was named or labelled.
 */
export async function inspectUpload(
  bytes: Buffer,
  limits: { maxBytes?: number; maxMegapixels?: number } = {},
): Promise<InspectedUpload> {
  const maxBytes = limits.maxBytes ?? env.uploads.maxBytes;
  const maxMegapixels = limits.maxMegapixels ?? env.uploads.maxMegapixels;

  if (bytes.byteLength === 0) {
    throw new UploadRejected('empty', 'That file was empty.');
  }
  if (bytes.byteLength > maxBytes) {
    throw new UploadRejected(
      'too_large',
      `That file is ${formatBytes(bytes.byteLength)}; the limit is ${formatBytes(maxBytes)}.`,
    );
  }

  let info: { width: number; height: number; format: string };
  try {
    // Reads the header only — no pixels are decoded here, so a bomb is caught
    // by the megapixel check below before anything expensive happens.
    info = await readImageInfo(bytes);
  } catch {
    throw new UploadRejected(
      'unsupported_type',
      "That file isn't an image we can read. Upload a PNG, JPEG or WebP.",
    );
  }

  const accepted = ACCEPTED_FORMATS[info.format];
  if (!accepted) {
    throw new UploadRejected(
      'unsupported_type',
      `${info.format.toUpperCase()} isn't supported. Upload a PNG, JPEG or WebP.`,
    );
  }

  const megapixels = (info.width * info.height) / 1_000_000;
  if (megapixels > maxMegapixels) {
    throw new UploadRejected(
      'too_many_pixels',
      `That image is ${info.width}x${info.height}; the limit is ${maxMegapixels} megapixels.`,
    );
  }

  return {
    width: info.width,
    height: info.height,
    format: info.format,
    mimeType: accepted.mimeType,
    extension: accepted.extension,
  };
}

/** Public URLs are our own route — object storage is never exposed. */
export function uploadUrls(id: string): { url: string; thumbUrl: string } {
  return { url: `/api/uploads/${id}`, thumbUrl: `/api/uploads/${id}/thumb` };
}

export function rowToUpload(row: UploadRow): Upload {
  const { url, thumbUrl } = uploadUrls(row.id);
  return {
    id: row.id,
    userId: row.user_id,
    url,
    // As in the library grid: a thumbnail that failed to generate falls back to
    // the full image, so the picker shows a slow tile rather than a broken one.
    thumbUrl: row.thumb_key ? thumbUrl : url,
    width: row.width,
    height: row.height,
    mimeType: row.mime_type,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SELECT_COLUMNS = `id, user_id, storage_key, thumb_key, mime_type,
                        width, height, size_bytes, created_at`;

export interface StoreUploadOptions {
  /** The owner. Every key is namespaced under it, and every read checks it. */
  userId: string;
  bytes: Buffer;
  maxBytes?: number;
  maxMegapixels?: number;
  driver?: StorageDriver;
  db?: UploadDb;
}

/**
 * Validate, store, thumbnail and record one dropped file.
 *
 * Throws {@link UploadRejected} for anything the user could fix; anything else
 * is a real fault and reaches the error handler as a 500.
 */
export async function storeUpload(opts: StoreUploadOptions): Promise<Upload> {
  const db = opts.db ?? realDb;
  const driver = opts.driver ?? storage();

  const info = await inspectUpload(opts.bytes, {
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.maxMegapixels !== undefined ? { maxMegapixels: opts.maxMegapixels } : {}),
  });

  const storageKey = buildKey({ userId: opts.userId, extension: info.extension });
  await driver.put(storageKey, opts.bytes, info.mimeType);

  let thumbKey: string | null = null;
  try {
    const thumb = await makeThumbnail(opts.bytes, env.storage.thumbMaxPx);
    thumbKey = buildKey({ userId: opts.userId, extension: thumb.extension, variant: 'thumb' });
    await driver.put(thumbKey, thumb.bytes, thumb.contentType);
  } catch {
    thumbKey = null;
  }

  const row = await db.queryOne<UploadRow>(
    `INSERT INTO uploads
       (user_id, storage_key, thumb_key, mime_type, width, height, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT_COLUMNS}`,
    [
      opts.userId,
      storageKey,
      thumbKey,
      info.mimeType,
      info.width,
      info.height,
      opts.bytes.byteLength,
    ],
  );

  if (!row) {
    // The INSERT has no ON CONFLICT, so this cannot happen — but if it ever
    // does, do not leave objects behind with no row pointing at them.
    await driver.delete(storageKey).catch(() => {});
    if (thumbKey) await driver.delete(thumbKey).catch(() => {});
    throw new Error('uploads INSERT returned no row.');
  }

  return rowToUpload(row);
}

function formatBytes(n: number): string {
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}
