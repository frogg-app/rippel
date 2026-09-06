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
import { z } from 'zod';
import type {
  BackendReadiness,
  ModelCatalogEntry,
  ModelInstall,
  ReadinessInstallResult,
} from '@comfy/shared';
import { query, queryOne } from '../db.js';
import { findTemplate, findTemplateById } from '../workflows/registry.js';
import type { WorkflowTemplate } from '../workflows/types.js';
import { ComfyError, type ObjectInfo } from '../lib/comfy.js';
import { objectInfoFor } from '../orchestrator/preflight.js';
import { previewBytes, withCatalogueInfo } from './metadata.js';
import { folderForSavePath, runnabilityFor } from './runnability.js';
import {
  activeInstalls,
  InstallConflict,
  refreshInstall,
  requireTransport,
  startInstall,
  toModelInstall,
  type InstallRow,
} from './installs.js';
import { readinessFor } from './readiness.js';
import { TransportError, TransportUnavailable, type ModelTransport } from './transport.js';

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
   *
   * Two things are added on top of the transport's answer, and neither of them
   * is allowed to break it:
   *
   *  - `info` — preview image, licence, downloads — merged in from the metadata
   *    cache. Anything not cached yet is resolved in the background and comes
   *    back on a later read; `pending` is how many model pages are still being
   *    resolved, so the UI knows whether re-asking is worth anything.
   *  - `runnability` — whether the entry would actually work on *this* backend.
   *    It needs `/object_info`, which is read through preflight's cache. A
   *    backend that will not answer produces a degraded verdict, never an
   *    error: this endpoint's job is to list a catalogue.
   */
  app.get<{ Params: { id: string } }>(
    '/backends/:id/catalogue',
    { onRequest: [app.requireAdmin] },
    async (req, reply) => {
      const backend = await adminBackend(req.params.id);
      if (!backend) return reply.code(404).send({ error: 'not_found', message: 'No such backend' });

      try {
        const transport = await requireTransport(backend.base_url);
        const raw: ModelCatalogEntry[] = await transport.catalogue();

        const { entries, pending } = await withCatalogueInfo(raw, (message) => req.log.info(message));

        let info: ObjectInfo | null = null;
        try {
          info = await objectInfoFor(backend.base_url);
        } catch {
          // Fail open. See the note at the top of runnability.ts.
          info = null;
        }

        return {
          entries: entries.map((entry) => ({
            ...entry,
            runnability: runnabilityFor({
              filename: entry.filename,
              type: entry.type,
              catalogueBase: entry.base,
              folder: folderForSavePath(entry.savePath, entry.type),
              info,
              backendId: backend.id,
              backendName: backend.name,
              installed: entry.installed,
            }),
          })),
          pending,
        };
      } catch (err) {
        return transportFailure(reply, err);
      }
    },
  );

  /**
   * One cached preview image.
   *
   * `requireAuth`, not `requireAdmin`: the catalogue itself is admin-only, but
   * these bytes are just pictures and the installed list wants them too. They
   * are served from our own origin on purpose — the browser must never be sent
   * to huggingface.co once per tile. See metadata.ts.
   */
  app.get<{ Params: { previewId: string }; Querystring: { full?: string } }>(
    '/model-previews/:previewId',
    { onRequest: [app.requireAuth] },
    async (req, reply) => {
      // The id is a hex digest we generated; anything else cannot match a row
      // and is refused before it reaches the database.
      if (!/^[0-9a-f]{20}$/.test(req.params.previewId)) {
        return reply.code(404).send({ error: 'not_found', message: 'No such preview' });
      }
      // `?full=1` is the ~1600px rendition, fetched only when somebody opens a
      // preview to look at it properly. The grid never asks for it: 48 cards of
      // it would be several megabytes to show pictures at 300px.
      const variant = req.query.full === '1' ? 'full' : 'tile';
      const found = await previewBytes(req.params.previewId, variant);
      if (!found) return reply.code(404).send({ error: 'not_found', message: 'No such preview' });

      // The bytes for an id change only when the sweep re-reads the model page,
      // which is monthly, so a long cache with a revalidation tag is right. The
      // variant is part of the tag, or a browser holding the tile would answer
      // the enlarged request from its own cache.
      const etag = `"${req.params.previewId}-${variant}-${found.fetchedAt.getTime()}"`;
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();

      return reply
        .header('content-type', found.contentType)
        .header('cache-control', 'private, max-age=86400')
        .header('etag', etag)
        .send(found.bytes);
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
        // Recording the row, telling the backend to start, and the two 409s
        // now live in `startInstall` — the single download path, shared with
        // the readiness route below.
        const install = await startInstall({
          backendId: backend.id,
          backendName: backend.name,
          requestedBy: req.user!.id,
          entry,
          transport,
        });

        return reply.code(202).send({ install });
      } catch (err) {
        if (err instanceof InstallConflict) {
          return reply.code(409).send({ error: 'conflict', message: err.message });
        }
        return transportFailure(reply, err);
      }
    },
  );

  // ------------------------------------------------------------- readiness

  const readinessQuery = z
    .object({
      /** A model from our library; its family chooses the template. */
      modelId: z.string().uuid().optional(),
      /** Which capability to check it for. Defaults to txt2img. */
      capability: z.enum(['txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale']).optional(),
      /** Or name the template outright, for "is this workflow usable at all". */
      templateId: z.string().min(1).max(64).optional(),
    })
    .refine((q) => q.modelId !== undefined || q.templateId !== undefined, {
      message: 'Pass either modelId or templateId',
    });

  /**
   * What a model (or a template) needs on this backend, what is there, what is
   * missing, and what would fix each gap.
   *
   * Open to any signed-in user, because "why can I not generate video" is a
   * question every user asks. Catalogue *offers* are still admin-only: they
   * name internal URLs and are only useful to somebody who can act on them, so
   * a non-admin gets the gaps and a note saying who to ask. That split is the
   * reason `transport` is a parameter of `readinessFor` rather than something
   * it works out for itself.
   */
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/backends/:id/readiness',
    { onRequest: [app.requireAuth] },
    async (req, reply) => {
      const backend = await adminBackend(req.params.id);
      if (!backend) return reply.code(404).send({ error: 'not_found', message: 'No such backend' });

      const parsed = readinessQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'bad_request',
          message: parsed.error.issues[0]?.message ?? 'Pass either modelId or templateId',
        });
      }

      const resolved = await resolveSubject(parsed.data);
      if ('error' in resolved) {
        return reply.code(resolved.status).send({ error: 'bad_request', message: resolved.error });
      }

      const isAdmin = req.user?.role === 'admin';
      let transport: ModelTransport | null = null;
      let transportReason: string | null = isAdmin
        ? null
        : 'Only an administrator can see or install catalogue models on this backend.';
      if (isAdmin) {
        try {
          transport = await requireTransport(backend.base_url);
        } catch (err) {
          transportReason = err instanceof Error ? err.message : String(err);
        }
      }

      try {
        const readiness = await readinessFor({
          backend,
          template: resolved.template,
          checkpointFilename: resolved.checkpointFilename,
          modelId: resolved.modelId,
          modelLabel: resolved.modelLabel,
          transport,
          transportReason,
        });
        return { readiness } satisfies { readiness: BackendReadiness };
      } catch (err) {
        // Without /object_info there is nothing honest to report; guessing at a
        // readiness screen is worse than saying the backend is unreachable.
        if (err instanceof ComfyError) {
          return reply.code(502).send({
            error: 'backend_error',
            message: `Could not read what ${backend.name} has installed: ${err.message}`,
          });
        }
        return transportFailure(reply, err);
      }
    },
  );

  const installBody = z.object({
    modelId: z.string().uuid().optional(),
    capability: z.enum(['txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale']).optional(),
    templateId: z.string().min(1).max(64).optional(),
    /**
     * Restrict the batch to these catalogue refs. Omit to queue every gap the
     * readiness check found — which is the one-click case the UI wants.
     */
    refs: z.array(z.string().min(1).max(400)).max(20).optional(),
  });

  /**
   * Close this backend's gaps for a model: queue a download for each missing
   * companion file.
   *
   * Deliberately *not* a second downloader. It recomputes readiness (so a
   * client working from a stale screen cannot ask for something that is already
   * there), then hands each entry to the same `startInstall` the catalogue
   * route uses — same rows, same polling, same idempotency. A gap that is
   * already downloading is skipped with a reason rather than failing the batch,
   * because the honest answer to "install the missing pieces" when one is
   * already on its way is "that one is already on its way".
   *
   * Misfiled files are never queued: ComfyUI-Manager believes it has already
   * installed them and would refuse. They come back in `manualSteps` instead.
   */
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/backends/:id/readiness/install',
    { onRequest: [app.requireAdmin] },
    async (req, reply) => {
      const backend = await adminBackend(req.params.id);
      if (!backend) return reply.code(404).send({ error: 'not_found', message: 'No such backend' });

      const parsed = installBody.safeParse(req.body ?? {});
      if (!parsed.success || (!parsed.data.modelId && !parsed.data.templateId)) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'Pass either modelId or templateId' });
      }

      const resolved = await resolveSubject(parsed.data);
      if ('error' in resolved) {
        return reply.code(resolved.status).send({ error: 'bad_request', message: resolved.error });
      }

      try {
        const transport = await requireTransport(backend.base_url);
        const readiness = await readinessFor({
          backend,
          template: resolved.template,
          checkpointFilename: resolved.checkpointFilename,
          modelId: resolved.modelId,
          modelLabel: resolved.modelLabel,
          transport,
        });

        const wanted = parsed.data.refs;
        // With no refs: the recommended one download per gap. With refs: any
        // entry this readiness check actually offered for a gap, which is wider
        // than `installable` on purpose — choosing the fp8 encoder over the
        // fp16, or a different LTX-Video build to sidestep a misfiled one, is
        // exactly the deliberate choice an operator should be able to make.
        const offered = new Map<string, ModelCatalogEntry>();
        for (const requirement of readiness.requirements) {
          if (requirement.status === 'satisfied') continue;
          for (const entry of requirement.offers) {
            if (!entry.installed) offered.set(entry.ref, entry);
          }
        }

        const chosen = wanted
          ? wanted.map((ref) => offered.get(ref)).filter((e): e is ModelCatalogEntry => !!e)
          : readiness.installable;

        // A ref the client asked for that is not a gap: usually a stale screen.
        const skipped: ReadinessInstallResult['skipped'] = [];
        for (const ref of wanted ?? []) {
          if (offered.has(ref)) continue;
          skipped.push({
            ref,
            filename: ref.split('/').pop() ?? ref,
            reason:
              'This is not one of the missing pieces for that workflow — it may already be ' +
              'installed, or the workflow no longer needs it.',
          });
        }

        const installs: ModelInstall[] = [];
        for (const entry of chosen) {
          try {
            installs.push(
              await startInstall({
                backendId: backend.id,
                backendName: backend.name,
                requestedBy: req.user!.id,
                entry,
                transport,
              }),
            );
          } catch (err) {
            if (err instanceof InstallConflict) {
              skipped.push({ ref: entry.ref, filename: entry.filename, reason: err.message });
              continue;
            }
            if (err instanceof TransportError) {
              skipped.push({ ref: entry.ref, filename: entry.filename, reason: err.message });
              continue;
            }
            throw err;
          }
        }

        return reply.code(202).send({
          installs,
          skipped,
          manualSteps: readiness.manualSteps,
        } satisfies ReadinessInstallResult);
      } catch (err) {
        if (err instanceof ComfyError) {
          return reply.code(502).send({
            error: 'backend_error',
            message: `Could not read what ${backend.name} has installed: ${err.message}`,
          });
        }
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

/**
 * What the caller is asking about: a model from the library, or a bare
 * template.
 *
 * Both readiness routes take the same pair of query shapes, and both need the
 * same three answers out of them — which template, which checkpoint filename,
 * and what to call it — so the resolution lives here once.
 *
 * The model path also looks the filename up *on this backend*, because that is
 * what the loader's option list will be compared against. The template path
 * has no model, so the graph's own literal stands in — which is exactly what a
 * dispatch would name, and is what makes "is the LTX-Video workflow usable at
 * all on this box" answerable before anybody has imported a model row.
 */
async function resolveSubject(
  q: { modelId?: string; capability?: string; templateId?: string },
): Promise<
  | {
      template: WorkflowTemplate;
      checkpointFilename: string | null;
      modelId: string | null;
      modelLabel: string | null;
    }
  | { error: string; status: 400 | 404 }
> {
  if (q.templateId) {
    const template = findTemplateById(q.templateId);
    if (!template) {
      return { error: `No workflow template called "${q.templateId}"`, status: 404 };
    }
    return { template, checkpointFilename: null, modelId: null, modelLabel: null };
  }

  const row = await queryOne<{
    id: string;
    display_name: string;
    base_model: string | null;
    filename: string;
  }>(
    `SELECT m.id, m.display_name, m.base_model, m.filename FROM models m WHERE m.id = $1`,
    [q.modelId],
  );
  if (!row) return { error: 'No such model', status: 404 };

  const capability = (q.capability ?? 'txt2img') as Parameters<typeof findTemplate>[0];
  const template = findTemplate(capability, row.base_model);
  if (!template) {
    return {
      error: `No ${capability} workflow exists for ${row.base_model ?? 'unknown'} models.`,
      status: 400,
    };
  }

  return {
    template,
    // The filename regardless of whether this backend is recorded as having it:
    // the whole point of the report is to say whether it can load it, and
    // withholding the name here would turn a clear "misfiled" into a blank.
    checkpointFilename: row.filename,
    modelId: row.id,
    modelLabel: row.display_name,
  };
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
