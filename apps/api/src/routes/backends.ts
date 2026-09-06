import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import type { Backend } from '@comfy/shared';

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
  queue_depth: string;
}

export default async function backendRoutes(app: FastifyInstance) {
  /**
   * The status pill in the top bar. Non-admins see it too — knowing whether the
   * GPU is up is not privileged information — but the base URL is withheld,
   * since that is an internal LAN address.
   */
  app.get('/backends', { onRequest: [app.requireAuth] }, async (req) => {
    const rows = await query<BackendRow>(
      `SELECT b.id, b.name, b.base_url, b.enabled, b.status, b.device_name,
              b.vram_free, b.vram_total, b.ram_free, b.ram_total,
              b.vram_limit_mb, b.last_seen_at,
              count(j.id) FILTER (
                WHERE j.status IN ('queued', 'dispatched', 'running', 'uploading')
              ) AS queue_depth
         FROM backends b
         LEFT JOIN jobs j ON j.backend_id = b.id
        GROUP BY b.id
        ORDER BY b.name`,
    );

    const isAdmin = req.user?.role === 'admin';
    const backends: (Backend & { baseUrl: string })[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: isAdmin ? row.base_url : '',
      enabled: row.enabled,
      status: row.status,
      deviceName: row.device_name,
      vramFree: row.vram_free === null ? null : Number(row.vram_free),
      vramTotal: row.vram_total === null ? null : Number(row.vram_total),
      ramFree: row.ram_free === null ? null : Number(row.ram_free),
      ramTotal: row.ram_total === null ? null : Number(row.ram_total),
      vramLimitMb: row.vram_limit_mb,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      queueDepth: Number(row.queue_depth),
    }));

    return { backends };
  });
}
