import { query, transaction } from '../db.js';
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

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO models (type, filename, display_name)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
       ON CONFLICT (type, filename) DO NOTHING`,
      [types, filenames, displayNames],
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
