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
import type { GenerationParams, Job, JobEvent, JobFit } from '@comfy/shared';
import { query, queryOne } from '../db.js';
import { compile, TemplateError, ValidationError } from '../compiler/index.js';
import { chooseTemplate } from '../models/workflow-choice.js';
import { candidatesFor, filenamesOn, sizesOn } from './select.js';
import { sizeOfJob } from './cost.js';
import { assessOn } from './fit.js';
import { preflight } from './preflight.js';
import { createJob, getJob, queuePosition, type JobRow } from './jobs.js';
import { jobWithAssets } from './runner.js';
import { publish, subscribe } from './events.js';
import { cancelJob } from './cancel.js';
import { publishQueuePositions } from './queue.js';
import { makeQueueRoutes } from './queue-routes.js';

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
  // Checked properly rather than passed through: a reference names a file we
  // will hand to a backend, so its shape is not something to discover at
  // dispatch. At most one `init` — it is the canvas, and two canvases is not a
  // thing the compiler can express.
  references: z
    .array(
      z.object({
        source: z.union([
          z.object({ from: z.literal('asset'), assetId: z.string().uuid() }),
          z.object({ from: z.literal('upload'), uploadId: z.string().uuid() }),
        ]),
        role: z.enum(['init', 'style', 'composition', 'face', 'depth', 'pose']),
        influence: z.number().min(0).max(1),
      }),
    )
    .max(8)
    .refine((refs) => refs.filter((r) => r.role === 'init').length <= 1, {
      message: 'Only one image can be the starting point.',
    })
    .optional(),
  advanced: z.record(z.unknown()).optional(),
  video: z.record(z.unknown()).optional(),
}).passthrough();

export default async function jobRoutes(app: FastifyInstance) {
  // The queue is the same objects seen from the outside, so it is registered
  // here rather than given its own top-level plugin.
  await app.register(makeQueueRoutes());

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

      // A starting image is what makes a generation img2img — the capability
      // follows from the request. A client that sends one alongside kind
      // 'txt2img' has a bug, and accepting it would be the worst outcome
      // available: the txt2img template has no LoadImage, so the image would be
      // silently dropped and the user would get an unrelated picture several
      // GPU-minutes later. Refuse it and say which field is wrong.
      const initRef = params.references?.find((ref) => ref.role === 'init');
      if (initRef && params.kind === 'txt2img') {
        return reply.code(400).send({
          error: 'invalid_input',
          message: "A starting image makes this an img2img generation; send kind: 'img2img'.",
        });
      }
      if (!initRef && params.kind === 'img2img') {
        return reply.code(400).send({
          error: 'invalid_input',
          message: 'An img2img generation needs a starting image.',
        });
      }

      const model = await queryOne<{ base_model: string | null; display_name: string; filename: string }>(
        'SELECT base_model, display_name, filename FROM models WHERE id = $1',
        [params.modelId],
      );
      if (!model) {
        return reply.code(400).send({ error: 'invalid_input', message: 'No such model.' });
      }

      // Not guarded on base_model being set: a null family is exactly what the
      // generic fallback template exists to serve, and short-circuiting here
      // would make it unreachable from job creation. The dispatcher chooses
      // again with the backend's own file list in hand; this is the early
      // "there is nothing for this family at all" refusal.
      const choice = await chooseTemplate({
        modelId: params.modelId,
        capability: params.kind,
        family: model.base_model,
        filename: model.filename,
      });
      const template = choice?.template;
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
      let compiled;
      try {
        const filenames = await filenamesOn(backend.id, [
          params.modelId,
          ...(params.loras ?? []).map((l) => l.modelId),
        ]);
        compiled = compile({
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

      // Having a compiled graph, ask the backend whether it can actually load
      // every file in it. Possession of the checkpoint is not enough: a
      // template can name a text encoder or a VAE of its own, and those are
      // exactly the ones nobody notices are missing until ComfyUI rejects the
      // prompt minutes later, at which point the user has waited for nothing.
      const problem = await preflight(compiled.graph, backend);
      if (problem) {
        return reply.code(422).send({ error: 'missing_files', message: problem });
      }

      const row = await createJob(req.user!.id, params, template.manifest.id);
      const job: Job = { ...(await jobWithAssets(row)), queuePosition: await queuePosition(row) };

      publish(row.user_id, { type: 'job.created', job });

      // Whether this machine has ever finished something this big. Best-effort
      // and never a refusal: the evidence is a bracket learned from history, and
      // history is not a promise in either direction — a machine that OOMed at
      // this size once may have had a browser open at the time. So it warns and
      // the job still runs. See `fit.ts`.
      let fit: JobFit | undefined;
      try {
        const sizes = await sizesOn(backend.id, [
          params.modelId,
          ...(params.loras ?? []).map((l) => l.modelId),
        ]);
        const size = sizeOfJob({
          manifest: template.manifest,
          params,
          width: compiled.resolved.width,
          height: compiled.resolved.height,
          fileBytes: Object.values(sizes),
        });
        const assessment = await assessOn(backend.id, size.score);
        fit = {
          verdict: assessment.verdict,
          note: assessment.note,
          observations: assessment.observations,
        };
      } catch {
        // A machine we cannot score is one we say nothing about.
      }

      return reply.code(202).send({ job, fit });
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
   * Owner or admin. What cancelling *does* lives in cancel.ts, shared with the
   * admin's `DELETE /queue/:id`: a queued job is ours to drop, a dispatched one
   * belongs to the backend and is asked for politely and disowned regardless.
   *
   * The scoping is in the read: a normal user passes their own id, so someone
   * else's job is indistinguishable from one that does not exist, while an
   * admin reads it unscoped.
   */
  app.post<{ Params: { id: string } }>(
    '/jobs/:id/cancel',
    { onRequest: [app.requireAuth] },
    async (req, reply) => {
      const user = req.user!;
      const row = await getJob(req.params.id, user.role === 'admin' ? undefined : user.id);
      if (!row) return reply.code(404).send({ error: 'not_found', message: 'No such job.' });

      const wasQueued = row.status === 'queued';
      const updated = await cancelJob(row);
      // Dropping one job out of the queue moves everybody behind it up; their
      // tabs learn that from the same `job.status` events they already handle.
      if (wasQueued) await publishQueuePositions();
      return { job: await jobWithAssets(updated) };
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
