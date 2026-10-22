/**
 * The layout of installed checkpoints, probed once and remembered.
 *
 * The answer is a property of the file, so it is stored on the model row
 * (`models.metadata.weightsLayout`) the first time it is learnt and never asked
 * for again. Learning it needs somewhere to read the header from, and the one
 * place rippel reliably has is the URL it installed the file from
 * (`model_installs.url`). A file that arrived some other way has no URL and
 * stays `unknown`, which blocks nothing.
 *
 * A failed probe is remembered in memory for a while rather than in the row, so
 * one network blip is not a permanent "unknown".
 */
import type { Uuid } from '@comfy/shared';
import { query } from '../db.js';
import { knownLayouts } from './url-layout.js';
import { UNLOADABLE_REASON } from './install-guard.js';
import { classifyWeightKeys, familyFromWeightKeys, readSafetensorsKeys, WEIGHTS_LAYOUTS, type WeightsLayout } from './weights-layout.js';

const FAILED_PROBE_TTL_MS = 10 * 60_000;
const failedAt = new Map<Uuid, number>();
const inFlight = new Map<Uuid, Promise<WeightsLayout>>();

/** Test seam. */
export const probeDeps = {
  read: readSafetensorsKeys,
};

export function resetWeightsProbe(): void {
  failedAt.clear();
  inFlight.clear();
}

function isLayout(value: unknown): value is WeightsLayout {
  return typeof value === 'string' && (WEIGHTS_LAYOUTS as readonly string[]).includes(value);
}

/**
 * Layouts for these model ids. Ones already known come from the row; the rest
 * are probed in parallel, and a probe that takes longer than `budgetMs` is left
 * running (its answer lands in the row for next time) while this returns
 * `unknown` for it now.
 */
export async function weightsLayouts(ids: readonly Uuid[], budgetMs = 6_000): Promise<Map<Uuid, WeightsLayout>> {
  const out = new Map<Uuid, WeightsLayout>();
  if (ids.length === 0) return out;

  const rows = await query<{ id: Uuid; type: string; filename: string; layout: string | null; url: string | null }>(
    `SELECT m.id, m.type, m.filename, m.metadata->>'weightsLayout' AS layout,
            (SELECT mi.url FROM model_installs mi
              WHERE mi.filename = m.filename AND mi.url LIKE 'https://%'
                AND (mi.status = 'complete' OR (mi.status = 'failed' AND mi.error = $2))
              ORDER BY mi.finished_at DESC NULLS LAST LIMIT 1) AS url
       FROM models m WHERE m.id = ANY($1::uuid[])`,
    [ids, UNLOADABLE_REASON],
  );

  const pending: Promise<void>[] = [];
  for (const row of rows) {
    if (isLayout(row.layout)) {
      out.set(row.id, row.layout);
      continue;
    }
    out.set(row.id, 'unknown');
    if (row.type !== 'checkpoint' || !row.url) continue;
    const failed = failedAt.get(row.id);
    if (failed && Date.now() - failed < FAILED_PROBE_TTL_MS) continue;

    let probe = inFlight.get(row.id);
    if (!probe) {
      probe = learn(row.id, row.url).finally(() => inFlight.delete(row.id));
      inFlight.set(row.id, probe);
    }
    pending.push(probe.then((layout) => void out.set(row.id, layout)));
  }

  if (pending.length > 0) {
    await Promise.race([
      Promise.all(pending),
      new Promise((resolve) => setTimeout(resolve, budgetMs).unref?.()),
    ]);
  }
  return out;
}

export async function weightsLayoutOf(id: Uuid, budgetMs?: number): Promise<WeightsLayout> {
  return (await weightsLayouts([id], budgetMs)).get(id) ?? 'unknown';
}

async function learn(id: Uuid, url: string): Promise<WeightsLayout> {
  // Read before install, from Discover or the install guard: no need to ask again.
  const known = (await knownLayouts([url])).get(url);
  if (known) {
    await remember(id, known);
    return known;
  }
  const keys = await probeDeps.read(url);
  if (!keys) {
    failedAt.set(id, Date.now());
    return 'unknown';
  }
  const layout = classifyWeightKeys(keys);
  await remember(id, layout);
  // The same header names the family more surely than any filename. Fills a
  // gap only, like every other family source: a family already on the row came
  // from an install record or a person.
  const family = familyFromWeightKeys(keys);
  if (family) {
    await query('UPDATE models SET base_model = $2 WHERE id = $1 AND base_model IS NULL', [id, family]).catch(() => undefined);
  }
  return layout;
}

async function remember(id: Uuid, layout: WeightsLayout): Promise<void> {
  await query(
    `UPDATE models SET metadata = metadata || jsonb_build_object('weightsLayout', $2::text) WHERE id = $1`,
    [id, layout],
  ).catch(() => undefined);
}
