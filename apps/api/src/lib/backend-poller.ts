import { query, transaction } from '../db.js';
import { inferFamily } from '../models/family.js';
import { ComfyClient, extractModels, prettyModelName } from './comfy.js';

const POLL_INTERVAL_MS = 15_000;

interface BackendRow {
  id: string;
  name: string;
  base_url: string;
}

/**
 * Every 15 seconds, ask each enabled backend whether it is alive and what it
 * has installed. Two things fall out of this:
 *
 *   - the online/offline pill the UI shows on every screen, and
 *   - the model library, which is discovered rather than configured.
 *
 * A backend that has gone away is marked offline, not deleted: its models stay
 * in the catalogue (greyed out) so a job referencing one still makes sense.
 */
export function startBackendPoller(log: (msg: string) => void = console.log): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const backends = await query<BackendRow>(
        `SELECT id, name, base_url FROM backends WHERE enabled = true`,
      );
      await Promise.all(backends.map((b) => pollOne(b, log)));
      // After the sweep, not before: a model discovered a moment ago may have
      // an install record naming its family, and that is better evidence than
      // anything its filename can offer.
      await backfillModelFamilies(log);
    } catch (err) {
      log(`poller: sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function pollOne(backend: BackendRow, log: (msg: string) => void): Promise<void> {
  const client = new ComfyClient(backend.base_url);

  let stats;
  try {
    stats = await client.systemStats();
  } catch {
    await query(
      `UPDATE backends SET status = 'offline' WHERE id = $1 AND status <> 'offline'`,
      [backend.id],
    );
    return;
  }

  // The first accelerator is the one ComfyUI will actually use. Its vram_total
  // is a reported budget, not the card's physical size — see 002_backend_capacity.sql.
  const device = stats.devices?.find((d) => d.type !== 'cpu') ?? stats.devices?.[0];
  await query(
    `UPDATE backends
        SET status = 'online',
            device_name = $2,
            vram_free = $3,
            vram_total = $4,
            ram_free = $5,
            ram_total = $6,
            system_info = $7,
            last_seen_at = now()
      WHERE id = $1`,
    [
      backend.id,
      device?.name ?? null,
      device?.vram_free ?? null,
      device?.vram_total ?? null,
      stats.system?.ram_free ?? null,
      stats.system?.ram_total ?? null,
      // Keep the whole payload: it is what the admin screen shows when the
      // summarised numbers look wrong, and it costs nothing to store.
      JSON.stringify({ system: stats.system ?? {}, devices: stats.devices ?? [] }),
    ],
  );

  try {
    const models = extractModels(await client.objectInfo());
    await syncModels(backend.id, models);
  } catch (err) {
    log(`poller: ${backend.name} is up but /object_info failed: ${
      err instanceof Error ? err.message : String(err)
    }`);
  }
}

/**
 * Reconcile what this backend reports against the catalogue: insert models we
 * have not seen before, and replace this backend's availability rows wholesale
 * so a file deleted on disk stops showing as installed here.
 */
async function syncModels(
  backendId: string,
  models: { type: string; filename: string }[],
): Promise<void> {
  if (models.length === 0) {
    await query(`DELETE FROM model_backends WHERE backend_id = $1`, [backendId]);
    return;
  }

  const types = models.map((m) => m.type);
  const filenames = models.map((m) => m.filename);
  const displayNames = models.map((m) => prettyModelName(m.filename));
  // Inferred from the reported path, subfolder included — `SDXL\foo.safetensors`
  // says more about the family than `foo.safetensors` does. Null when the name
  // is not evidence enough; `backfillModelFamilies` gets a second go later with
  // the install record, which is better evidence when we have one.
  const families = models.map((m) => inferFamily({ filename: m.filename }));

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO models (type, filename, display_name, base_model)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
       ON CONFLICT (type, filename) DO UPDATE
          -- Only ever fills a gap. A family already on the row came from an
          -- install record or from an operator correcting us, and both of those
          -- outrank a guess made from the filename.
          SET base_model = EXCLUDED.base_model
          -- The WHERE matters for more than tidiness: without it every sweep
          -- rewrites every model row every 15 seconds, churning dead tuples for
          -- no change at all.
          WHERE models.base_model IS NULL AND EXCLUDED.base_model IS NOT NULL`,
      [types, filenames, displayNames, families],
    );

    await client.query(`DELETE FROM model_backends WHERE backend_id = $1`, [backendId]);

    await client.query(
      `INSERT INTO model_backends (model_id, backend_id)
       SELECT m.id, $1
         FROM models m
         JOIN unnest($2::text[], $3::text[]) AS reported(type, filename)
           ON m.type = reported.type AND m.filename = reported.filename
       ON CONFLICT DO NOTHING`,
      [backendId, types, filenames],
    );
  });
}

interface FamilylessModelRow {
  id: string;
  filename: string;
  /** `ModelCatalogEntry.base` from the install that put this file here, if any. */
  catalogue_base: string | null;
}

/**
 * Give a family to every `models` row that still lacks one.
 *
 * This is a repeated pass rather than a migration on purpose. The inference
 * rules live in TypeScript and will keep changing as families appear (a
 * migration would freeze one copy of them in SQL that can never be corrected),
 * and the two evidence sources arrive at different times: discovery sees the
 * filename within 15s, while the install record that states the family
 * authoritatively may land afterwards. Running it after every sweep means a
 * newly installed model is correctly filed within one poll interval, that a
 * deploy carrying better rules fixes rows nobody could classify before, and
 * that no schema change is needed — `models.base_model` has existed since
 * 001_init.sql. The pass only ever *fills* a null, so an operator's correction
 * is never overwritten, and it touches nothing once every row is classified.
 */
export async function backfillModelFamilies(
  log: (msg: string) => void = console.log,
): Promise<number> {
  const rows = await query<FamilylessModelRow>(
    // ComfyUI reports a checkpoint in a subfolder as `SDXL\name.safetensors`
    // while the install recorded the bare `name.safetensors`, so the join is on
    // the last path segment.
    `SELECT m.id, m.filename,
            (SELECT i.base_model
               FROM model_installs i
              WHERE i.status = 'complete'
                AND i.model_type = m.type
                AND i.filename = regexp_replace(m.filename, '^.*[\\\\/]', '')
              ORDER BY i.finished_at DESC NULLS LAST
              LIMIT 1) AS catalogue_base
       FROM models m
      WHERE m.base_model IS NULL`,
  );
  if (rows.length === 0) return 0;

  const ids: string[] = [];
  const families: string[] = [];
  for (const row of rows) {
    const family = inferFamily({ filename: row.filename, catalogueBase: row.catalogue_base });
    // Still unrecognisable: leave it null. A wrong family silently selects the
    // wrong template, which is worse than the UI saying "family unknown" and
    // asking an operator to set one.
    if (!family) continue;
    ids.push(row.id);
    families.push(family);
  }
  if (ids.length === 0) return 0;

  await query(
    `UPDATE models m
        SET base_model = v.family
       FROM unnest($1::uuid[], $2::text[]) AS v(id, family)
      WHERE m.id = v.id AND m.base_model IS NULL`,
    [ids, families],
  );
  log(`poller: filled in the model family for ${ids.length} model(s)`);
  return ids.length;
}
