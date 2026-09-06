/**
 * The queue routes.
 *
 *     GET    /queue                 authenticated; everyone sees the queue
 *     POST   /queue/:id/priority    admin; { position: 'top' }
 *     DELETE /queue/:id             admin; cancels someone else's queued job
 *
 * `POST /jobs/:id/cancel` stays where it is, owner-or-admin, and shares this
 * module's cancel path (orchestrator/cancel.ts) so the two cannot drift.
 *
 * Handlers are thin on purpose: the privacy rule and the ordering live in
 * queue.ts, where they are unit-testable without a database. What is left here
 * is parsing, status codes, and telling the people behind the moved job.
 *
 * Built as a factory rather than a bare plugin so the dependencies can be
 * substituted in tests — a route test of "a normal user gets 403" should not
 * need Postgres to prove it.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getJob as defaultGetJob, toJob } from './jobs.js';
import { cancelJob as defaultCancelJob, realCancelDeps } from './cancel.js';
import { loadQueueView, promoteToTop, publishQueuePositions, realDb, type QueueDb } from './queue.js';

export interface QueueRouteDeps {
  db?: QueueDb;
  getJob?: typeof defaultGetJob;
  cancelJob?: typeof defaultCancelJob;
}

const idParams = z.object({ id: z.string().uuid() });

// Only one position is expressible today, and it is spelled out rather than
// left open: 'top' is a queue operation an admin can reason about, whereas an
// arbitrary index would be a promise about ordering we cannot keep once the
// dispatch loop moves underneath it.
const priorityBody = z.object({ position: z.literal('top') });

export function makeQueueRoutes(deps: QueueRouteDeps = {}): FastifyPluginAsync {
  const db = deps.db ?? realDb;
  const getJob = deps.getJob ?? defaultGetJob;
  const cancelJob = deps.cancelJob ?? ((row) => defaultCancelJob(row, realCancelDeps));

  return async function queueRoutes(app: FastifyInstance) {
    /**
     * The queue, for anybody signed in.
     *
     * Not admin-only, deliberately: knowing that ten jobs are ahead of you is
     * the difference between waiting and reloading the page in frustration.
     * What is withheld is other people's prompts, not the queue's existence.
     */
    app.get('/queue', { onRequest: [app.requireAuth] }, async (req) => {
      const user = req.user!;
      return loadQueueView({ viewerId: user.id, isAdmin: user.role === 'admin', db });
    });

    /**
     * Move a queued job to the front. Admin only.
     *
     * Answers with the job as it now stands — the same shape `POST
     * /jobs/:id/cancel` answers with — and publishes to every user whose place
     * in the queue just changed, which is everyone behind it.
     */
    app.post<{ Params: { id: string } }>(
      '/queue/:id/priority',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const params = idParams.safeParse(req.params);
        if (!params.success) {
          return reply.code(400).send({ error: 'invalid_input', message: 'That is not a job id.' });
        }
        const body = priorityBody.safeParse(req.body);
        if (!body.success) {
          return reply
            .code(400)
            .send({ error: 'invalid_input', message: "The only position is 'top'." });
        }

        const row = await promoteToTop(params.data.id, db);
        if (!row) {
          // Either there is no such job or it is no longer queued, and the two
          // are worth telling apart: an admin who promotes a job the runner
          // took a second ago should be told it has already started.
          const existing = await getJob(params.data.id);
          if (!existing) {
            return reply.code(404).send({ error: 'not_found', message: 'No such job.' });
          }
          return reply.code(409).send({
            error: 'not_queued',
            message: `That job is already ${existing.status}; only a waiting job can be moved.`,
          });
        }

        await publishQueuePositions(db);
        return { job: toJob(row) };
      },
    );

    /**
     * Cancel somebody else's job. Admin only.
     *
     * Reuses the same cancel path as the owner's own route, so a dispatched job
     * is dropped from ComfyUI's queue here exactly as it is there — including
     * the part where an unreachable backend still leaves the job cancelled
     * rather than stuck.
     */
    app.delete<{ Params: { id: string } }>(
      '/queue/:id',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const params = idParams.safeParse(req.params);
        if (!params.success) {
          return reply.code(400).send({ error: 'invalid_input', message: 'That is not a job id.' });
        }

        const row = await getJob(params.data.id);
        if (!row) return reply.code(404).send({ error: 'not_found', message: 'No such job.' });

        await cancelJob(row);
        // Everything behind it has moved up by one.
        await publishQueuePositions(db);
        return reply.code(204).send();
      },
    );
  };
}
