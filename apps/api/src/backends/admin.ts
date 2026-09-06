/**
 * Backend management for administrators: add a ComfyUI server, change it,
 * remove it, and ask whether it answers.
 *
 * Until now backends came only from `COMFY_BACKENDS` at seed time, so the one
 * way to point rippel at a second GPU was an env edit and a restart. These
 * routes make that a form. They deliberately do nothing clever: a backend is
 * a name and a URL, and the poller (lib/backend-poller.ts) learns everything
 * else about it within one tick — sooner, because a create or edit asks for
 * an immediate poll.
 *
 * The probe is what makes the form honest before Save: it hits `/system_stats`
 * with a short timeout and reports latency, version and the first device, or
 * the reason it could not. It never writes anything.
 */

import type { FastifyInstance } from 'fastify';
import type { Backend, BackendInput, BackendProbe } from '@comfy/shared';
import { query as defaultQuery, queryOne as defaultQueryOne } from '../db.js';
import { pollBackendNow } from '../lib/backend-poller.js';

export interface AdminDb {
  query: typeof defaultQuery;
  queryOne: typeof defaultQueryOne;
}

export interface AdminDeps {
  db?: AdminDb;
  /** `fetch`, injectable so the probe can be tested without a network. */
  fetch?: typeof globalThis.fetch;
  /** Called after a create or edit; fire-and-forget. */
  pollNow?: (id: string) => Promise<void>;
  probeTimeoutMs?: number;
}

interface BackendRow {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  status: 'online' | 'offline' | 'unknown';
  device_name: string | null;
  vram_free: string | null;
  vram_total: string | null;
  ram_free: string | null;
  ram_total: string | null;
  vram_limit_mb: number | null;
  last_seen_at: Date | null;
}

const SELECT_BACKEND = `SELECT id, name, base_url, enabled, status, device_name,
                               vram_free, vram_total, ram_free, ram_total,
                               vram_limit_mb, last_seen_at
                          FROM backends`;

function toBackend(row: BackendRow): Backend {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled,
    status: row.status,
    deviceName: row.device_name,
    vramFree: row.vram_free === null ? null : Number(row.vram_free),
    vramTotal: row.vram_total === null ? null : Number(row.vram_total),
    ramFree: row.ram_free === null ? null : Number(row.ram_free),
    ramTotal: row.ram_total === null ? null : Number(row.ram_total),
    vramLimitMb: row.vram_limit_mb,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    // Freshly created or edited: whatever was queued is still queued, but the
    // list route is the one that counts it. Zero here is not a claim.
    queueDepth: 0,
  };
}

// ---------------------------------------------------------------- validation

export type Invalid = { field: string; message: string };

/** A trimmed http(s) URL with no path, query or trailing slash, or null. */
export function normaliseBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

export function validateInput(
  body: unknown,
  partial: boolean,
): { ok: true; value: Partial<BackendInput> } | { ok: false; error: Invalid } {
  const b = (body ?? {}) as Record<string, unknown>;
  const value: Partial<BackendInput> = {};

  if ('name' in b || !partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return { ok: false, error: { field: 'name', message: 'Give the backend a name.' } };
    if (name.length > 60) return { ok: false, error: { field: 'name', message: 'Keep the name under 60 characters.' } };
    value.name = name;
  }

  if ('baseUrl' in b || !partial) {
    const baseUrl = normaliseBaseUrl(b.baseUrl);
    if (!baseUrl) {
      return {
        ok: false,
        error: { field: 'baseUrl', message: 'Enter the ComfyUI address as http://host:port.' },
      };
    }
    value.baseUrl = baseUrl;
  }

  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') {
      return { ok: false, error: { field: 'enabled', message: 'enabled must be true or false.' } };
    }
    value.enabled = b.enabled;
  }

  if ('vramLimitMb' in b) {
    const limit = b.vramLimitMb;
    if (limit === null) value.vramLimitMb = null;
    else if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit < 1_000_000) {
      value.vramLimitMb = limit;
    } else {
      return {
        ok: false,
        error: { field: 'vramLimitMb', message: 'The memory limit is a whole number of MB, or empty.' },
      };
    }
  }

  return { ok: true, value };
}

// ---------------------------------------------------------------- probe

export async function probeBackend(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 4000,
): Promise<BackendProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/system_stats`, { signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, latencyMs, error: `The server answered ${res.status}, not like ComfyUI does.` };
    }
    const stats = (await res.json()) as {
      system?: { comfyui_version?: string };
      devices?: { name?: string; type?: string; vram_total?: number }[];
    };
    const device = stats.devices?.find((d) => d.type !== 'cpu') ?? stats.devices?.[0];
    return {
      ok: true,
      latencyMs,
      version: stats.system?.comfyui_version,
      device: device?.name,
      vramTotal: device?.vram_total,
    };
  } catch (cause) {
    const latencyMs = Date.now() - started;
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      latencyMs,
      error: aborted
        ? `No answer within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not connect: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- routes

export function makeBackendAdminRoutes(deps: AdminDeps = {}) {
  const db: AdminDb = deps.db ?? { query: defaultQuery, queryOne: defaultQueryOne };
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const pollNow = deps.pollNow ?? ((id: string) => pollBackendNow(id));
  const timeoutMs = deps.probeTimeoutMs ?? 4000;

  const kick = (id: string) => {
    void pollNow(id).catch(() => {});
  };

  return async function backendAdminRoutes(app: FastifyInstance) {
    app.post<{ Body: unknown }>('/backends', { onRequest: [app.requireAdmin] }, async (req, reply) => {
      const checked = validateInput(req.body, false);
      if (!checked.ok) {
        return reply.code(400).send({ error: 'invalid_input', message: checked.error.message, field: checked.error.field });
      }
      const { name, baseUrl, enabled = true, vramLimitMb = null } = checked.value as BackendInput;

      const taken = await db.queryOne<{ id: string }>(`SELECT id FROM backends WHERE lower(name) = lower($1)`, [name]);
      if (taken) {
        return reply.code(409).send({ error: 'conflict', message: `There is already a backend called "${name}".`, field: 'name' });
      }

      const row = await db.queryOne<BackendRow>(
        `INSERT INTO backends (name, base_url, enabled, vram_limit_mb)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, base_url, enabled, status, device_name, vram_free, vram_total,
                   ram_free, ram_total, vram_limit_mb, last_seen_at`,
        [name, baseUrl, enabled, vramLimitMb],
      );
      kick(row!.id);
      return reply.code(201).send({ backend: toBackend(row!) });
    });

    app.patch<{ Params: { id: string }; Body: unknown }>(
      '/backends/:id',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const existing = await db.queryOne<BackendRow>(`${SELECT_BACKEND} WHERE id = $1`, [req.params.id]);
        if (!existing) return reply.code(404).send({ error: 'not_found', message: 'No such backend.' });

        const checked = validateInput(req.body, true);
        if (!checked.ok) {
          return reply.code(400).send({ error: 'invalid_input', message: checked.error.message, field: checked.error.field });
        }
        const patch = checked.value;
        if (Object.keys(patch).length === 0) {
          return reply.code(400).send({ error: 'invalid_input', message: 'Nothing to change.' });
        }

        if (patch.name !== undefined && patch.name.toLowerCase() !== existing.name.toLowerCase()) {
          const taken = await db.queryOne<{ id: string }>(
            `SELECT id FROM backends WHERE lower(name) = lower($1) AND id <> $2`,
            [patch.name, existing.id],
          );
          if (taken) {
            return reply.code(409).send({ error: 'conflict', message: `There is already a backend called "${patch.name}".`, field: 'name' });
          }
        }

        const row = await db.queryOne<BackendRow>(
          `UPDATE backends
              SET name = COALESCE($2, name),
                  base_url = COALESCE($3, base_url),
                  enabled = COALESCE($4, enabled),
                  vram_limit_mb = CASE WHEN $5::boolean THEN $6::integer ELSE vram_limit_mb END,
                  -- A new address is a new machine as far as status goes.
                  status = CASE WHEN $3::text IS NOT NULL AND $3 <> base_url THEN 'unknown' ELSE status END
            WHERE id = $1
            RETURNING id, name, base_url, enabled, status, device_name, vram_free, vram_total,
                      ram_free, ram_total, vram_limit_mb, last_seen_at`,
          [
            existing.id,
            patch.name ?? null,
            patch.baseUrl ?? null,
            patch.enabled ?? null,
            'vramLimitMb' in patch,
            patch.vramLimitMb ?? null,
          ],
        );
        kick(existing.id);
        return { backend: toBackend(row!) };
      },
    );

    app.delete<{ Params: { id: string } }>(
      '/backends/:id',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const existing = await db.queryOne<BackendRow>(`${SELECT_BACKEND} WHERE id = $1`, [req.params.id]);
        if (!existing) return reply.code(404).send({ error: 'not_found', message: 'No such backend.' });

        const busy = await db.queryOne<{ n: string }>(
          `SELECT count(*)::text AS n FROM jobs
            WHERE backend_id = $1 AND status IN ('dispatched', 'running', 'uploading')`,
          [existing.id],
        );
        if (busy && Number(busy.n) > 0) {
          return reply.code(409).send({
            error: 'busy',
            message: `${existing.name} is generating right now. Wait for the job to finish, or cancel it, then remove the backend.`,
          });
        }

        await db.query(`DELETE FROM backends WHERE id = $1`, [existing.id]);
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { id: string } }>(
      '/backends/:id/probe',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const existing = await db.queryOne<BackendRow>(`${SELECT_BACKEND} WHERE id = $1`, [req.params.id]);
        if (!existing) return reply.code(404).send({ error: 'not_found', message: 'No such backend.' });
        return probeBackend(existing.base_url, fetchImpl, timeoutMs);
      },
    );

    app.post<{ Body: { baseUrl?: unknown } }>(
      '/backends/probe',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const baseUrl = normaliseBaseUrl(req.body?.baseUrl);
        if (!baseUrl) {
          return reply.code(400).send({
            error: 'invalid_input',
            message: 'Enter the ComfyUI address as http://host:port.',
            field: 'baseUrl',
          });
        }
        return probeBackend(baseUrl, fetchImpl, timeoutMs);
      },
    );
  };
}

export default makeBackendAdminRoutes();
