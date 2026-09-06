/**
 * Model install routes.
 *
 * Installing is admin-only. It writes multi-gigabyte files to a machine shared
 * by every user and there is no per-user quota on disk, so this is an operator
 * action rather than something a generation user can trigger. Reading the
 * catalogue is admin-only for the same reason: it is only useful to someone who
 * can act on it, and it names internal URLs.
 */

import type { FastifyInstance } from 'fastify';
import type { ModelCatalogEntry } from '@comfy/shared';
import { query, queryOne } from '../db.js';
import {
  activeInstalls,
  createInstall,
  refreshInstall,
  requestFromRow,
  requireTransport,
  toModelInstall,
  type InstallRow,
} from './installs.js';
import { TransportError, TransportUnavailable } from './transport.js';

interface BackendUrlRow {
  id: string;
  base_url: string;
  name: string;
}

export default async function modelInstallRoutes(app: FastifyInstance) {
  /** Reject anything but an admin, and hand back the backend's URL. */
  async function adminBackend(backendId: string): Promise<BackendUrlRow | null> {
    return queryOne<BackendUrlRow>(
      'SELECT id, base_url, name FROM backends WHERE id = $1',
      [backendId],
    );
  }

  /**
   * What this backend is able to install. Comes from the backend itself rather
   * than a list we hold, because the transport will refuse anything it does not
   * recognise — see the whitelist note on ComfyManagerTransport.
   */
  app.get<{ Params: { id: string } }>(
    '/backends/:id/catalogue',
    { onRequest: [app.requireAdmin] },
    async (req, reply) => {
      const backend = await adminBackend(req.params.id);
      if (!backend) return reply.code(404).send({ error: 'not_found', message: 'No such backend' });

      try {
        const transport = await requireTransport(backend.base_url);
        const entries: ModelCatalogEntry[] = await transport.catalogue();
        return { entries };
      } catch (err) {
        return transportFailure(reply, err);
      }
    },
  );

  /** Ask a backend to download one catalogue entry. */
  app.post<{ Params: { id: string }; Body: { ref?: string } }>(
    '/backends/:id/models',
    { onRequest: [app.requireAdmin] },
    async (req, reply) => {
      const backend = await adminBackend(req.params.id);
      if (!backend) return reply.code(404).send({ error: 'not_found', message: 'No such backend' });

      const ref = req.body?.ref;
      if (!ref) {
        return reply.code(400).send({ error: 'bad_request', message: 'A catalogue "ref" is required' });
      }

      try {
        const transport = await requireTransport(backend.base_url);

        // Resolve the ref against the live catalogue rather than trusting the
        // client's copy of it: the URL and save_path we send must be the ones
        // the transport's whitelist will match, and a client working from a
        // stale catalogue would otherwise produce a confusing 400 from the
        // backend instead of a clear one from us.
        const entry = (await transport.catalogue()).find((e) => e.ref === ref);
        if (!entry) {
          return reply
            .code(400)
            .send({ error: 'bad_request', message: `This backend does not offer "${ref}"` });
        }
        if (entry.installed) {
          return reply
            .code(409)
            .send({ error: 'conflict', message: `${entry.filename} is already installed` });
        }

        let row: InstallRow;
        try {
          row = await createInstall({
            backendId: backend.id,
            requestedBy: req.user!.id,
            entry,
          });
        } catch (err) {
          // The partial unique index on (backend_id, filename) for live rows.
          if (isUniqueViolation(err)) {
            return reply.code(409).send({
              error: 'conflict',
              message: `${entry.filename} is already being installed on ${backend.name}`,
            });
          }
          throw err;
        }

        // Only now do we tell the backend to start: a failure to record the
        // install would otherwise leave a download running that nothing tracks.
        try {
          await transport.install(requestFromRow(row));
        } catch (err) {
          await query(
            `UPDATE model_installs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
            [row.id, err instanceof Error ? err.message : String(err)],
          );
          return transportFailure(reply, err);
        }

        return reply.code(202).send({ install: toModelInstall(row) });
      } catch (err) {
        return transportFailure(reply, err);
      }
    },
  );

  /** Install history for a backend, newest first. */
  app.get<{ Params: { id: string } }>(
    '/backends/:id/models/installs',
    { onRequest: [app.requireAdmin] },
    async (req) => {
      const rows = await query<InstallRow>(
        `SELECT * FROM model_installs WHERE backend_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [req.params.id],
      );
      return { installs: rows.map(toModelInstall) };
    },
  );

  /**
   * One install, refreshed from the backend on read. The poller updates these
   * on a timer anyway; doing it here too means a UI that is watching a download
   * sees movement as soon as it asks, without waiting out a poll interval.
   */
  app.get<{ Params: { id: string; installId: string } }>(
    '/backends/:id/models/installs/:installId',
    { onRequest: [app.requireAdmin] },
    async (req, reply) => {
      const row = await queryOne<InstallRow & { base_url: string }>(
        `SELECT mi.*, b.base_url
           FROM model_installs mi
           JOIN backends b ON b.id = mi.backend_id
          WHERE mi.id = $1 AND mi.backend_id = $2`,
        [req.params.installId, req.params.id],
      );
      if (!row) return reply.code(404).send({ error: 'not_found', message: 'No such install' });

      if (row.status === 'queued' || row.status === 'downloading') {
        return { install: await refreshInstall(row, row.base_url) };
      }
      return { install: toModelInstall(row) };
    },
  );

  /** Every in-flight install, across backends. */
  app.get('/model-installs', { onRequest: [app.requireAdmin] }, async () => {
    const rows = await activeInstalls();
    return { installs: rows.map(toModelInstall) };
  });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Transport problems are the backend's fault, not the caller's, but "Manager
 * isn't installed" is a configuration answer an operator can act on, so it gets
 * its own status rather than being flattened into a 502.
 */
function transportFailure(reply: import('fastify').FastifyReply, err: unknown) {
  if (err instanceof TransportUnavailable) {
    return reply.code(501).send({ error: 'not_implemented', message: err.message });
  }
  if (err instanceof TransportError) {
    return reply.code(502).send({ error: 'backend_error', message: err.message });
  }
  throw err;
}
