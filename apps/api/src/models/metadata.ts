/**
 * The cache in front of the model pages.
 *
 * Reading one HuggingFace repo costs two or three HTTPS round trips plus an
 * image download, and the Discover tab asks about 132 of them at once. So
 * nothing here happens in a request: a catalogue read merges in whatever is
 * already cached and, if anything is missing or stale, starts a background
 * sweep and tells the caller how many entries are still being resolved. The UI
 * polls; the grid fills in.
 *
 * The cache is a table (`model_catalogue_meta`, migration 008) rather than a
 * Map, for the plain reason that the expensive part is the *discovery* — which
 * of a repo's files is the sample image — and redoing all of it on every API
 * restart would be a self-inflicted rate limit. Rows are keyed by model page,
 * so the 11 GGUF quantisations of FLUX.1-dev share one row, one licence and one
 * picture.
 *
 * ## Why the bytes are stored, not the URL
 *
 * The obvious cheap version — cache the image *URL* and let the browser fetch
 * it — is the one thing this must not do. 372 tiles pointing at huggingface.co
 * tells a third party exactly which models this studio is browsing, breaks on
 * an air-gapped LAN (which is the deployment this product is for), and gives
 * every tile a load time nobody controls. So the API fetches each picture once,
 * downscales it to a 640x360 WebP with sharp — a 9 MB PNG becomes ~30 kB — and
 * serves it from `/api/model-previews/<id>`. A whole catalogue is tens of
 * megabytes in Postgres rather than the ~390 MB the originals weigh.
 *
 * ## What "no picture" means
 *
 * It means no picture. Roughly half the catalogue is text encoders, VAEs and
 * quantisations whose repos contain nothing but weights, and inventing
 * something for those — a stock photo, a picture of a *different* model found
 * by name search — would be worse than the family gradient the card already
 * falls back to. Measured coverage on the live catalogue: 179 of 372 entries
 * have a candidate, 146 of 372 resolve to an image that downloads.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ModelCatalogEntry, ModelCatalogInfo } from '@comfy/shared';
import { query } from '../db.js';
import {
  fetchSourceFacts,
  parseReference,
  sourceKeyOf,
  sourceLabel,
  sourceUrl,
  UnsupportedSource,
  type SourceRef,
} from './metadata-sources.js';

/** How long a good answer stands. Model pages change slowly; licences rarely. */
const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long a failure stands. Long enough that a gated repo or a 451 is not
 * retried on every page load, short enough that a repo that was briefly down
 * heals without an operator doing anything.
 */
const RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Four at a time: polite to huggingface.co, and quick enough on 132 repos. */
const SWEEP_CONCURRENCY = 4;

/** Refuse to pull an original bigger than this. Some sample GIFs are 37 MB. */
const MAX_DOWNLOAD_BYTES = 24 * 1024 * 1024;

/** The card's art band is a wide strip; 640x360 covers it at 2x on any screen. */
const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 360;

export interface MetaRow {
  source_key: string;
  preview_id: string;
  reference_url: string;
  license: string | null;
  downloads: string | null;
  likes: number | null;
  pipeline_tag: string | null;
  preview_source: string | null;
  preview_borrowed_from: string | null;
  preview_type: string | null;
  has_preview: boolean;
  error: string | null;
  fetched_at: Date;
}

/**
 * URL-safe, stable, short. The source key contains a slash (`hf:owner/repo`)
 * and cannot be a path segment; a hash of it can.
 */
export function previewIdFor(sourceKey: string): string {
  return createHash('sha256').update(sourceKey).digest('hex').slice(0, 20);
}

function toInfo(row: MetaRow): ModelCatalogInfo {
  return {
    previewUrl: row.has_preview ? `/api/model-previews/${row.preview_id}` : null,
    previewFrom: row.has_preview ? row.preview_source : null,
    previewBorrowedFrom: row.has_preview ? row.preview_borrowed_from : null,
    license: row.license,
    // bigint comes back as a string from pg; a download count is well inside
    // Number's range and the UI wants to format it.
    downloads: row.downloads === null ? null : Number(row.downloads),
    likes: row.likes,
    pipelineTag: row.pipeline_tag,
    referenceUrl: row.reference_url,
  };
}

/** Everything we hold for a set of model pages. */
async function loadRows(keys: string[]): Promise<Map<string, MetaRow>> {
  if (keys.length === 0) return new Map();
  const rows = await query<MetaRow>(
    `SELECT source_key, preview_id, reference_url, license, downloads, likes, pipeline_tag,
            preview_source, preview_borrowed_from, preview_type,
            preview_bytes IS NOT NULL AS has_preview, error, fetched_at
       FROM model_catalogue_meta
      WHERE source_key = ANY($1::text[])`,
    [keys],
  );
  return new Map(rows.map((row) => [row.source_key, row]));
}

function isStale(row: MetaRow): boolean {
  const age = Date.now() - row.fetched_at.getTime();
  return row.error ? age > RETRY_MS : age > FRESH_MS;
}

/**
 * Merge cached facts onto a backend's catalogue.
 *
 * Returns the entries with `info` filled in where we have it, plus how many
 * model pages are still unresolved — which is what the UI polls on. Never
 * throws for a metadata problem: a catalogue that lists nothing but filenames
 * is the status quo, and it is strictly better than an error page.
 */
export async function withCatalogueInfo(
  entries: ModelCatalogEntry[],
  log: (message: string) => void = () => {},
): Promise<{ entries: ModelCatalogEntry[]; pending: number }> {
  const refs = new Map<string, SourceRef>();
  for (const entry of entries) {
    const ref = parseReference(entry.reference);
    if (ref) refs.set(sourceKeyOf(ref), ref);
  }

  let rows: Map<string, MetaRow>;
  try {
    rows = await loadRows([...refs.keys()]);
  } catch (err) {
    log(`catalogue metadata: cache unreadable (${String(err)})`);
    return { entries, pending: 0 };
  }

  const stale: SourceRef[] = [];
  for (const [key, ref] of refs) {
    const row = rows.get(key);
    if (!row || isStale(row)) stale.push(ref);
  }
  if (stale.length > 0) void startSweep(stale, log);

  const withInfo = entries.map((entry) => {
    const ref = parseReference(entry.reference);
    const row = ref ? rows.get(sourceKeyOf(ref)) : undefined;
    return { ...entry, info: row ? toInfo(row) : null };
  });

  return { entries: withInfo, pending: stale.length };
}

// ---------------------------------------------------------------- the sweep

/**
 * One sweep at a time, process-wide.
 *
 * Two admins opening Discover at once must not double every outbound request,
 * and a sweep that is already running will pick up anything the second caller
 * would have asked for anyway — it re-reads what is stale as it goes.
 */
let running: Promise<void> | null = null;

export function sweepInFlight(): boolean {
  return running !== null;
}

/** Resolves when no sweep is running. For tests and for shutdown. */
export async function sweepSettled(): Promise<void> {
  while (running) await running;
}

async function startSweep(refs: SourceRef[], log: (message: string) => void): Promise<void> {
  if (running) return running;
  const started = Date.now();
  running = (async () => {
    let resolved = 0;
    let withPicture = 0;
    const queue = [...refs];
    const workers = Array.from({ length: Math.min(SWEEP_CONCURRENCY, queue.length) }, async () => {
      for (let ref = queue.pop(); ref; ref = queue.pop()) {
        const outcome = await resolveOne(ref).catch((err: unknown) => {
          log(`catalogue metadata: ${sourceLabel(ref)} failed hard: ${String(err)}`);
          return null;
        });
        resolved += 1;
        if (outcome) withPicture += 1;
      }
    });
    await Promise.all(workers);
    log(
      `catalogue metadata: resolved ${resolved} model page(s), ${withPicture} with a preview, ` +
        `in ${Math.round((Date.now() - started) / 1000)}s`,
    );
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Resolve one model page and store it. Returns true if we stored a picture. */
async function resolveOne(ref: SourceRef): Promise<boolean> {
  const key = sourceKeyOf(ref);

  let facts;
  try {
    facts = await fetchSourceFacts(ref);
  } catch (err) {
    const message = err instanceof UnsupportedSource ? err.message : String(err);
    await store({ key, referenceUrl: sourceUrl(ref), error: message });
    return false;
  }

  let candidates = facts.imageCandidates;
  let borrowedFrom: string | null = null;

  // The one hop: a repo with no picture of its own that declares exactly one
  // parent. See the note in metadata-sources.ts for why only one.
  if (candidates.length === 0 && facts.derivedFrom) {
    try {
      const parent = await fetchSourceFacts(facts.derivedFrom);
      if (parent.imageCandidates.length > 0) {
        candidates = parent.imageCandidates;
        borrowedFrom =
          facts.derivedFrom.kind === 'huggingface' ? facts.derivedFrom.repo : facts.derivedFrom.id;
      }
    } catch {
      // A parent we cannot read simply means no borrowed picture.
    }
  }

  // Three attempts, not one: the top-ranked candidate is sometimes a link to a
  // file that has been deleted, or an LFS pointer that serves as text/plain.
  let preview: { bytes: Buffer; from: string } | null = null;
  for (const candidate of candidates.slice(0, 3)) {
    preview = await downloadPreview(candidate);
    if (preview) break;
  }

  await store({
    key,
    referenceUrl: facts.referenceUrl,
    license: facts.license,
    downloads: facts.downloads,
    likes: facts.likes,
    pipelineTag: facts.pipelineTag,
    preview,
    borrowedFrom,
  });
  return preview !== null;
}

/**
 * Fetch one candidate and turn it into a card-sized WebP.
 *
 * Everything that can go wrong here is ordinary — a 404, an HTML error page
 * served with a 200, a 37 MB animated GIF, a file sharp cannot decode — and all
 * of it means "try the next candidate", never "fail the entry".
 */
async function downloadPreview(url: string): Promise<{ bytes: Buffer; from: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'comfy-studio/0.1 (self-hosted)' },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').startsWith('image/')) return null;

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_DOWNLOAD_BYTES) return null;

    const original = Buffer.from(await res.arrayBuffer());
    if (original.byteLength === 0 || original.byteLength > MAX_DOWNLOAD_BYTES) return null;

    const bytes = await sharp(original, { animated: false })
      // `attention` crops towards the busiest region, which on a sample sheet
      // is the picture rather than the whitespace around it.
      .resize(PREVIEW_WIDTH, PREVIEW_HEIGHT, { fit: 'cover', position: 'attention' })
      .webp({ quality: 76 })
      .toBuffer();

    return { bytes, from: hostAndPath(url) };
  } catch {
    return null;
  }
}

/** "huggingface.co/org/repo/…/sample.png" — provenance a person can read. */
function hostAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${decodeURIComponent(parsed.pathname)}`;
  } catch {
    return url;
  }
}

async function store(params: {
  key: string;
  referenceUrl: string;
  license?: string | null;
  downloads?: number | null;
  likes?: number | null;
  pipelineTag?: string | null;
  preview?: { bytes: Buffer; from: string } | null;
  borrowedFrom?: string | null;
  error?: string | null;
}): Promise<void> {
  const preview = params.preview ?? null;
  await query(
    `INSERT INTO model_catalogue_meta
       (source_key, preview_id, reference_url, license, downloads, likes, pipeline_tag,
        preview_source, preview_borrowed_from, preview_bytes, preview_type, error, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (source_key) DO UPDATE SET
       reference_url = EXCLUDED.reference_url,
       license = EXCLUDED.license,
       downloads = EXCLUDED.downloads,
       likes = EXCLUDED.likes,
       pipeline_tag = EXCLUDED.pipeline_tag,
       -- A refresh that found no picture keeps the one we already have: repos
       -- reorganise, and a card that loses its image on a routine re-read is a
       -- regression nobody asked for.
       preview_source = COALESCE(EXCLUDED.preview_source, model_catalogue_meta.preview_source),
       preview_borrowed_from = CASE
         WHEN EXCLUDED.preview_bytes IS NOT NULL THEN EXCLUDED.preview_borrowed_from
         ELSE model_catalogue_meta.preview_borrowed_from END,
       preview_bytes = COALESCE(EXCLUDED.preview_bytes, model_catalogue_meta.preview_bytes),
       preview_type = COALESCE(EXCLUDED.preview_type, model_catalogue_meta.preview_type),
       error = EXCLUDED.error,
       fetched_at = now()`,
    [
      params.key,
      previewIdFor(params.key),
      params.referenceUrl,
      params.license ?? null,
      params.downloads ?? null,
      params.likes ?? null,
      params.pipelineTag ?? null,
      preview?.from ?? null,
      params.borrowedFrom ?? null,
      preview?.bytes ?? null,
      preview ? 'image/webp' : null,
      params.error ?? null,
    ],
  );
}

/** The bytes behind `/api/model-previews/:id`, or null. */
export async function previewBytes(
  previewId: string,
): Promise<{ bytes: Buffer; contentType: string; fetchedAt: Date } | null> {
  const rows = await query<{ preview_bytes: Buffer; preview_type: string | null; fetched_at: Date }>(
    `SELECT preview_bytes, preview_type, fetched_at
       FROM model_catalogue_meta
      WHERE preview_id = $1 AND preview_bytes IS NOT NULL`,
    [previewId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    bytes: row.preview_bytes,
    contentType: row.preview_type ?? 'image/webp',
    fetchedAt: row.fetched_at,
  };
}
