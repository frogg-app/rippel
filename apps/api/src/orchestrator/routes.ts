/**
 * Job routes and the browser event socket.
 *
 * Creating a job validates and compiles *before* anything is written, so a
 * request that cannot possibly run is refused synchronously with a message
 * naming the control the user got wrong — rather than being accepted, queued,
 * and failed thirty seconds later somewhere they are not looking.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GenerationParams, Job, JobEvent } from '@comfy/shared';
import { query, queryOne } from '../db.js';
import { compile, TemplateError, ValidationError } from '../compiler/index.js';
import { findTemplate } from '../workflows/registry.js';
import { candidatesFor, filenamesOn } from './select.js';
import { createJob, getJob, queuePosition, setStatus, type JobRow } from './jobs.js';
import { jobWithAssets } from './runner.js';
import { publish, subscribe } from './events.js';

/**
 * Shallow validation only. The manifest is the authority on what a legal value
 * is — ranges live there so the UI and the API cannot disagree — so this checks
 * shape and lets the compiler check meaning.
 */
const generationParams = z.object({
  kind: z.enum(['txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale']),
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  modelId: z.string().uuid(),
  quality: z.enum(['fast', 'balanced', 'high']),
  aspect: z.enum(['1:1', '3:2', '2:3', '16:9', '9:16']),
  batchSize: z.number().int().min(1).max(8),
  loras: z.array(z.object({ modelId: z.string().uuid(), weight: z.number() })).optional(),
  references: z.array(z.unknown()).optional(),
  advanced: z.record(z.unknown()).optional(),
  video: z.record(z.unknown()).optional(),
}).passthrough();

export default async function jobRoutes(app: FastifyInstance) {
  app.post<{ Body: { params?: unknown } }>(
    '/jobs',
    { onRequest: [app.requireAuth] },
    async (req, reply) => {
      const parsed = generationParams.safeParse(req.body?.params);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_input',
          message: parsed.error.issues[0]?.message ?? 'That request is not a valid generation.',
        });
      }
      const params = parsed.data as unknown as GenerationParams;

      const model = await queryOne<{ base_model: string | null; display_name: string }>(
        'SELECT base_model, display_name FROM models WHERE id = $1',
        [params.modelId],
      );
      if (!model) {
        return reply.code(400).send({ error: 'invalid_input', message: 'No such model.' });
      }

      const template = model.base_model ? findTemplate(params.kind, model.base_model) : undefined;
      if (!template) {
        return reply.code(501).send({
          error: 'no_template',
          message: model.base_model
            ? `There is no ${params.kind} workflow for ${model.base_model} models yet.`
            : `${model.display_name} has not been matched to a model family, so no workflow can be chosen for it.`,
        });
      }

      // A backend must hold the model *now*. Checking here turns a job that
      // would sit queued forever into an immediate, explicable refusal.
      const candidates = await candidatesFor(params.modelId);
      const backend = candidates[0];
      if (!backend) {
        return reply.code(409).send({
          error: 'no_backend',
          message: 'No online backend has that model right now.',
        });
      }

      // Compile before persisting: this is where a bad steps value or an
      // unknown sampler is caught, and it costs nothing to find out now.
      try {
        const filenames = await filenamesOn(backend.id, [
          params.modelId,
          ...(params.loras ?? []).map((l) => l.modelId),
        ]);
        compile({
          params,
          template,
          modelFilenames: filenames,
          // A placeholder id: this compile is a dry run for validation, and the
          // real one at dispatch uses the actual job id for the output prefix.
          jobId: '00000000-0000-4000-8000-000000000000',
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.code(400).send({ error: 'invalid_input', message: err.message });
        }
        if (err instanceof TemplateError) {
          return reply.code(500).send({ error: 'template_error', message: err.message });
        }
        throw err;
      }

      const row = await createJob(req.user!.id, params, template.manifest.id);
      const job: Job = { ...(await jobWithAssets(row)), queuePosition: await queuePosition(row) };

      publish(row.user_id, { type: 'job.created', job });
      return reply.code(202).send({ job });
    },
  );

  app.get<{ Querystring: { limit?: string; status?: string } }>(
    '/jobs',
    { onRequest: [app.requireAuth] },
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const statuses = req.query.status?.split(',').filter(Boolean);

      const rows = await query<JobRow>(
        `SELECT * FROM jobs
          WHERE user_id = $1
            AND ($2::text[] IS NULL OR status = ANY($2::text[]))
          ORDER BY created_at DESC
          LIMIT $3`,
        [req.user!.id, statuses ?? null, limit],
      );

      return { jobs: await Promise.all(rows.map(jobWithAssets)) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/jobs/:id',
    { onRequest: [app.requireAuth] },
    async (req, reply) => {
      const row = await getJob(req.params.id, req.user!.id);
      if (!row) return reply.code(404).send({ error: 'not_found', message: 'No such job.' });

      const job = await jobWithAssets(row);
      return {
        job: { ...job, queuePosition: row.status === 'queued' ? await queuePosition(row) : null },
      };
    },
  );

  /**
   * Cancel.
   *
   * A queued job is ours to drop. A dispatched one belongs to the backend, and
   * ComfyUI's own queue is the only thing that can stop it — so we ask, and
   * mark it cancelled regardless, because a user who cancels should not be left
   * watching something they have disowned.
   */
  app.post<{ Params: { id: string } }>(
    '/jobs/:id/cancel',
    { onRequest: [app.requireAuth] },
    async (req, reply) => {
      const row = await getJob(req.params.id, req.user!.id);
      if (!row) return reply.code(404).send({ error: 'not_found', message: 'No such job.' });

      if (['complete', 'failed', 'cancelled'].includes(row.status)) {
        return { job: await jobWithAssets(row) };
      }

      if (row.comfy_prompt_id && row.backend_id) {
        const backend = await queryOne<{ base_url: string }>(
          'SELECT base_url FROM backends WHERE id = $1',
          [row.backend_id],
        );
        if (backend) {
          await fetch(`${backend.base_url}/queue`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ delete: [row.comfy_prompt_id] }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => {
            // Best effort: if the backend will not listen, the job is still
            // cancelled from the user's point of view.
          });
        }
      }

      const updated = await setStatus(row.id, 'cancelled');
      return { job: await jobWithAssets(updated ?? row) };
    },
  );

  /**
   * The browser event socket.
   *
   * Authenticated by the same session cookie as everything else — the upgrade
   * request carries it — and scoped to that user for its whole life. There is
   * no subscribe message and no room to join: a connection sees exactly one
   * user's events and nothing else, which is a much easier property to keep
   * true than a filter applied per frame.
   */
  app.get('/events', { websocket: true, onRequest: [app.requireAuth] }, (socket, req) => {
    const userId = req.user!.id;

    const unsubscribe = subscribe(userId, (event: JobEvent) => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(event));
      } catch {
        // A send that throws means the socket is going away; close will follow.
      }
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}
