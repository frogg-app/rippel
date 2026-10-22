/**
 * The weights-layout check, before install.
 *
 * `weights-probe.ts` learns what an *installed* file holds. That is too late
 * for a diffusers-format file: by then a person has downloaded several
 * gigabytes ComfyUI cannot load. The header read is two small range requests
 * against the download URL, so it is just as cheap before the install, and the
 * answer is remembered per URL in `weights_layouts` for every later card,
 * install and installed model.
 *
 * Only Hugging Face URLs are probed: they are what the catalogue offers, they
 * serve ranges, and refusing anything else keeps this from being a way to make
 * the server fetch arbitrary addresses. A failed probe is "unknown" (blocks
 * nothing) and is retried after a while rather than stored.
 */
import { query } from '../db.js';
import { classifyWeightKeys, readSafetensorsKeys, WEIGHTS_LAYOUTS, type WeightsLayout } from './weights-layout.js';

const FAILED_PROBE_TTL_MS = 10 * 60_000;
const MAX_PARALLEL = 4;
const failedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<WeightsLayout>>();

/** Test seam. */
export const urlLayoutDeps = {
  read: readSafetensorsKeys,
};

export function resetUrlLayouts(): void {
  failedAt.clear();
  inFlight.clear();
}

export function probeable(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)huggingface\.co$/i.test(parsed.hostname) && /\.safetensors$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isLayout(value: unknown): value is WeightsLayout {
  return typeof value === 'string' && (WEIGHTS_LAYOUTS as readonly string[]).includes(value);
}

/** What is already known, without probing anything. */
export async function knownLayouts(urls: readonly string[]): Promise<Map<string, WeightsLayout>> {
  const out = new Map<string, WeightsLayout>();
  const wanted = [...new Set(urls.filter(probeable))];
  if (wanted.length === 0) return out;
  const rows = await query<{ url: string; layout: string }>(
    'SELECT url, layout FROM weights_layouts WHERE url = ANY($1::text[])',
    [wanted],
  ).catch(() => []);
  for (const row of rows) if (isLayout(row.layout)) out.set(row.url, row.layout);
  return out;
}

/**
 * Layouts for these URLs, probing the ones not yet known. A probe slower than
 * `budgetMs` keeps running (its answer is stored for next time) and reads
 * `unknown` now.
 */
export async function layoutsForUrls(urls: readonly string[], budgetMs = 6_000): Promise<Map<string, WeightsLayout>> {
  const out = await knownLayouts(urls);
  const todo = [...new Set(urls.filter(probeable))].filter((url) => !out.has(url));
  for (const url of todo) out.set(url, 'unknown');

  const pending: Promise<void>[] = [];
  let next = 0;
  const lane = async () => {
    while (next < todo.length) {
      const url = todo[next++]!;
      const failed = failedAt.get(url);
      if (failed && Date.now() - failed < FAILED_PROBE_TTL_MS) continue;
      let probe = inFlight.get(url);
      if (!probe) {
        probe = learn(url).finally(() => inFlight.delete(url));
        inFlight.set(url, probe);
      }
      out.set(url, await probe);
    }
  };
  for (let i = 0; i < Math.min(MAX_PARALLEL, todo.length); i++) pending.push(lane());

  if (pending.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
    clearTimeout(timer);
  }
  return new Map(out);
}

export async function layoutForUrl(url: string | null | undefined, budgetMs?: number): Promise<WeightsLayout> {
  if (!probeable(url)) return 'unknown';
  return (await layoutsForUrls([url], budgetMs)).get(url) ?? 'unknown';
}

async function learn(url: string): Promise<WeightsLayout> {
  const keys = await urlLayoutDeps.read(url);
  if (!keys) {
    failedAt.set(url, Date.now());
    return 'unknown';
  }
  const layout = classifyWeightKeys(keys);
  await query(
    `INSERT INTO weights_layouts (url, layout) VALUES ($1, $2)
     ON CONFLICT (url) DO UPDATE SET layout = EXCLUDED.layout, checked_at = now()`,
    [url, layout],
  ).catch(() => undefined);
  return layout;
}
