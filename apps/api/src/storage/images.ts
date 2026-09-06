/**
 * Image inspection and thumbnailing, via sharp.
 *
 * The library grid asks for hundreds of images at once, so it must never be
 * served full-size PNGs — a 1024x1024 SDXL output is several megabytes, and a
 * screen of them is a hundred. Every asset therefore gets one webp thumbnail at
 * a fixed maximum edge, generated once at persist time.
 */

import sharp from 'sharp';
import { env } from '../env.js';

export interface ImageInfo {
  width: number;
  height: number;
  /** sharp's name for the container: "png", "jpeg", "webp", … */
  format: string;
}

export interface Thumbnail {
  bytes: Buffer;
  contentType: 'image/webp';
  extension: 'webp';
  width: number;
  height: number;
}

/**
 * Read the real pixel dimensions off the bytes.
 *
 * The requested width/height in the job params is not the answer: a template
 * may round to a multiple of 64, a model may produce its own native size, and
 * an upscale step changes it entirely. The asset row records what actually came
 * back, because that is what the UI lays out against.
 */
export async function readImageInfo(bytes: Buffer): Promise<ImageInfo> {
  const meta = await sharp(bytes).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Could not read image dimensions — the output may not be an image.');
  }
  // An EXIF orientation of 5-8 means the stored buffer is transposed relative
  // to how every viewer will draw it, so report the displayed size.
  const swapped = typeof meta.orientation === 'number' && meta.orientation >= 5;
  return {
    width: swapped ? meta.height : meta.width,
    height: swapped ? meta.width : meta.height,
    format: meta.format ?? 'unknown',
  };
}

/**
 * A thumbnail whose longest edge is `maxPx`, preserving aspect ratio and never
 * enlarging a small image. webp because it is roughly half the bytes of jpeg at
 * the same quality and every browser we target reads it.
 */
export async function makeThumbnail(bytes: Buffer, maxPx = env.storage.thumbMaxPx): Promise<Thumbnail> {
  const out = await sharp(bytes)
    // Honour EXIF rotation before resizing, or portrait shots come out sideways.
    .rotate()
    .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: out.data,
    contentType: 'image/webp',
    extension: 'webp',
    width: out.info.width,
    height: out.info.height,
  };
}

/** Map a ComfyUI output filename onto the extension we store it under. */
export function extensionFor(filename: string, format?: string): string {
  const fromName = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  if (format === 'jpeg') return 'jpg';
  return format ?? 'png';
}
