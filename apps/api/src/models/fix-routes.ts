/** Admin-only plans name their exact remote operations before confirmation. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModelType } from '@comfy/shared';
import { queryOne } from '../db.js';
import { objectInfoFor, clearObjectInfoCache } from '../orchestrator/preflight.js';
import { folderOfInstalled } from '../workflows/folders.js';
import { findTemplateById } from '../workflows/registry.js';
import { buildFixPlan } from './fix-plan.js';
import { runnabilityFor } from './runnability.js';
import { planOperation, startOperation, getOperation, type ModelOperation } from './operations.js';
export default async function fixRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/model-operations/:id', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ message: 'Invalid operation.' });
    const operation = await getOperation(req.params.id);
    return operation ? { operation } : reply.code(404).send({ message: 'No such operation.' });
  });
  app.post<{ Params: { id: string } }>('/model-operations/:id/start', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ message: 'Invalid operation.' });
    const operation = await startOperation(req.params.id);
    return operation ? { operation } : reply.code(404).send({ message: 'No such operation.' });
  });

  app.get<{ Params: { id: string }; Querystring: { backendId?: string } }>('/models/:id/fix', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success || !z.string().uuid().safeParse(req.query.backendId).success) return reply.code(400).send({ message: 'Choose a model and backend.' });
    return { operation: await queryOne<ModelOperation>('SELECT * FROM model_operations WHERE model_id=$1 AND backend_id=$2 ORDER BY created_at DESC LIMIT 1', [req.params.id,req.query.backendId]) };
  });
  app.post<{ Params: { id: string } }>('/models/:id/fix-plan', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const parsed = z.object({ backendId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ message: 'Choose a model and backend.' });
    const model = await queryOne<{ filename: string; type: ModelType; base_model: string | null }>(
      'SELECT m.* FROM models m JOIN model_backends mb ON mb.model_id=m.id WHERE m.id=$1 AND mb.backend_id=$2', [req.params.id,parsed.data.backendId]);
    const backend = await queryOne<{ id: string; name: string; base_url: string }>('SELECT id,name,base_url FROM backends WHERE id=$1', [parsed.data.backendId]);
    if (!model || !backend) return reply.code(404).send({ message: 'This backend does not report holding the model.' });
    const agent = await queryOne('SELECT id FROM deployments WHERE backend_id=$1', [backend.id]);
    if (!agent) return reply.code(409).send({ message: 'Connect a rippel agent to this backend before fixing files.' });
    clearObjectInfoCache(backend.base_url);
    const info = await objectInfoFor(backend.base_url);
    const verdict = runnabilityFor({ filename: model.filename, type: model.type, catalogueBase: model.base_model,
      folder: folderOfInstalled(info,model.filename), info, backendId: backend.id, backendName: backend.name, installed: true });
    const template = verdict.templateId ? findTemplateById(verdict.templateId) : undefined;
    if (!template) return reply.code(422).send({ message: 'No workflow can fix this model. Choose one from the workflow library.' });
    const plan = await buildFixPlan({ template, filename: model.filename, info });
    if (!plan.steps.length) return reply.code(422).send({ message: plan.unavailable.join(' ') || 'No automatic file fix is available. Custom-node installation is pending design approval.' });
    return { operation: await planOperation({ backendId: backend.id, modelId: req.params.id, actorId: req.user!.id, steps: plan.steps }), unavailable: plan.unavailable };
  });
}
