import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { queryOne } from '../db.js';
import { AgentError, agentClient } from '../deploy/agent-client.js';

/** Only a pending download can nominate a host. This is not an arbitrary
 * allowlist editor; the agent validates the exact pending hostname again. */
export async function hostApprovalRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string; installId: string } }>(
    '/backends/:id/models/installs/:installId/host-approval',
    { onRequest: [app.requireAdmin] }, async (req, reply) => {
      const body = z.object({ hostname: z.string().min(1).max(253), approve: z.boolean() }).strict().safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'Choose whether to approve this host.' });
      const row = await queryOne<{ host: string; agent_port: number; token: string; agent_task_id: string }>(
        `SELECT d.host, d.agent_port, d.token, o.agent_task_id
         FROM model_installs i JOIN model_operations o ON o.id=i.operation_id AND o.backend_id=i.backend_id
         JOIN deployments d ON d.backend_id=i.backend_id
         WHERE i.id=$1 AND i.backend_id=$2 AND i.status IN ('queued','downloading')
           AND o.status='running' AND o.agent_task_id IS NOT NULL
         ORDER BY d.created_at DESC LIMIT 1`, [req.params.installId, req.params.id]);
      if (!row) return reply.code(409).send({ error: 'not_pending', message: 'This download is no longer waiting for approval.' });
      const target = { host: row.host, agentPort: row.agent_port, token: row.token };
      try {
        const { task } = await agentClient.task(target, row.agent_task_id, 0);
        if (task.status !== 'running' || task.approvalRequired?.hostname !== body.data.hostname)
          return reply.code(409).send({ error: 'not_pending', message: 'This download is no longer waiting for this host.' });
        await agentClient.approveModelHost(target, task.id, body.data);
        return { ok: true };
      } catch (error) {
        if (error instanceof AgentError) return reply.code(error.status === 409 ? 409 : 502).send({ error: 'agent_error', message: error.status === 409 ? 'This approval request has already changed.' : 'Could not reach the agent. Try again.' });
        throw error;
      }
    });
}
