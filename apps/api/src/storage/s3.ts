/**
 * S3-compatible storage driver. Talks to AWS S3, MinIO (the optional Compose
 * service), Backblaze B2, Cloudflare R2 — anything that speaks the API.
 *
 * Objects are kept private: nothing here ever sets a public ACL or hands out a
 * bucket URL. The browser always reads through our own route, which is where
 * ownership is enforced.
 */

import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  assertSafeKey,
  contentTypeForKey,
  StorageNotFound,
  type StorageDriver,
  type StoredObject,
} from './driver.js';

export interface S3DriverOptions {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  /**
   * MinIO and most self-hosted gateways only support path-style addressing
   * (`http://host/bucket/key`); virtual-host style needs per-bucket DNS. On by
   * default because self-hosting is the common case here.
   */
  forcePathStyle: boolean;
}

/** The SDK signals a missing object several ways depending on the server. */
function isMissing(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3DriverOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      endpoint: opts.endpoint || undefined,
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const { stream } = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  async getStream(key: string): Promise<StoredObject> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) throw new StorageNotFound(key);
      return {
        // In Node the SDK always yields a Readable; the union covers browsers.
        stream: res.Body as Readable,
        contentType: res.ContentType ?? contentTypeForKey(key),
        size: typeof res.ContentLength === 'number' ? res.ContentLength : null,
      };
    } catch (err) {
      if (isMissing(err)) throw new StorageNotFound(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
