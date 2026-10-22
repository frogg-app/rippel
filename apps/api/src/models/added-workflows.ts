/**
 * Workflows added for one model from its own panel: suggest, add, follow, remove.
 *
 * Adding reuses the library import (`library/workflows/routes.ts#prepare`) with
 * the workflow's main loader pointed at this model's file, downloads the
 * workflow's other files through the model-operation queue, then runs the same
 * test generation an admin import needs. Only a passed test makes the model
 * "Will run" (`addedVerdicts`), exactly as for any imported workflow.
 *
 * Links live in `model_added_workflows`, so a model can list and remove what was
 * added for it, and a Library view can later list every link.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { JobKind, ModelRunnability, Uuid } from '@comfy/shared';
import { query, queryOne } from '../db.js';
import { workflowLibrary } from '../library/workflows/catalogue.js';
import { prepare } from '../library/workflows/routes.js';
import { saveImport } from '../library/workflows/store.js';
import { startWorkflowTest } from '../library/workflows/tests.js';
import { verifiedFile } from './download-metadata.js';
import { familyFromCatalogueBase } from './family.js';
import { getOperation, planOperation, startOperation } from './operations.js';
import { familyForEntry, rankLibraryEntries } from './workflow-suggestions.js';

/** Test seam. */
export const addedDeps = { prepare, saveImport, startWorkflowTest, planOperation, startOperation, getOperation, verifiedFile };

const ADDABLE = new Set(['untested', 'ready', 'needs-files']);
/** How many ranked candidates are converted to find the few that can be added. */
const CHECK_AT_MOST = 6;
const SHOW_AT_MOST = 3;

interface ModelRow { id: string; filename: string; base_model: string | null; type: string }
interface BackendRow { id: string; base_url: string }

export interface AddedWorkflow {
  workflowId: string; title: string; capability: JobKind; backendId: string | null;
  phase: 'downloading' | 'testing' | 'ready' | 'failed';
  error: string | null;
  progress: { bytesReceived?: number; bytesTotal?: number } | null;
}

async function modelOn(modelId: string, backendId: string) {
  const model = await queryOne<ModelRow>(
    `SELECT m.id, m.filename, m.base_model, m.type FROM models m
       JOIN model_backends mb ON mb.model_id = m.id WHERE m.id = $1 AND mb.backend_id = $2`, [modelId, backendId]);
  const backend = await queryOne<BackendRow>('SELECT id, base_url FROM backends WHERE id = $1', [backendId]);
  return model && backend ? { model, backend } : null;
}

/**
 * Where an added workflow stands, moving it on when it can: a finished download
 * starts its test. Safe to call repeatedly; the test claim is single-flight.
 */
export async function addedState(modelId: string, workflowId: string): Promise<AddedWorkflow | null> {
  const row = await queryOne<{ title: string; capability: JobKind; backend_id: string | null; operation_id: string | null;
    test_status: string | null; test_result: { error?: string } | null }>(
    `SELECT w.title, w.capability, a.backend_id, a.operation_id, t.status AS test_status, t.result AS test_result
       FROM model_added_workflows a JOIN imported_workflows w ON w.id = a.workflow_id
       LEFT JOIN workflow_backend_tests t ON t.workflow_id = w.id AND t.backend_id = a.backend_id
      WHERE a.model_id = $1 AND a.workflow_id = $2`, [modelId, workflowId]);
  if (!row) return null;
  const base = { workflowId, title: row.title, capability: row.capability, backendId: row.backend_id, error: null, progress: null };
  if (row.test_status === 'ready') return { ...base, phase: 'ready' };
  if (row.test_status === 'failed') return { ...base, phase: 'failed', error: row.test_result?.error ?? 'The test generation failed.' };
  if (row.test_status === 'testing') return { ...base, phase: 'testing' };
  const operation = row.operation_id ? await addedDeps.getOperation(row.operation_id) : null;
  if (operation && operation.status !== 'done') {
    if (operation.status === 'failed') return { ...base, phase: 'failed', error: operation.error ?? 'The download failed.' };
    return { ...base, phase: 'downloading', progress: (operation.progress as AddedWorkflow['progress']) ?? null };
  }
  if (!row.backend_id) return { ...base, phase: 'failed', error: 'The machine was removed.' };
  try {
    await addedDeps.startWorkflowTest(workflowId, row.backend_id);
    return { ...base, phase: 'testing' };
  } catch (error) {
    return { ...base, phase: 'failed', error: (error as Error).message };
  }
}

/**
 * "Will run" for models whose added workflow passed its test on a machine,
 * keyed by model id then backend id.
 */
export async function addedVerdicts(modelIds: readonly Uuid[]): Promise<Map<Uuid, Map<Uuid, ModelRunnability>>> {
  const out = new Map<Uuid, Map<Uuid, ModelRunnability>>();
  if (modelIds.length === 0) return out;
  const rows = await query<{ model_id: Uuid; backend_id: Uuid; workflow_id: string; title: string; capability: JobKind; family: string }>(
    `SELECT a.model_id, t.backend_id, w.id AS workflow_id, w.title, w.capability, w.family
       FROM model_added_workflows a JOIN imported_workflows w ON w.id = a.workflow_id
       JOIN workflow_backend_tests t ON t.workflow_id = w.id AND t.status = 'ready'
      WHERE a.model_id = ANY($1::uuid[]) ORDER BY a.added_at`, [modelIds]);
  for (const row of rows) {
    const byBackend = out.get(row.model_id) ?? new Map<Uuid, ModelRunnability>();
    out.set(row.model_id, byBackend);
    const held = byBackend.get(row.backend_id);
    if (held) {
      if (!held.capabilities.includes(row.capability)) held.capabilities.push(row.capability);
      continue;
    }
    byBackend.set(row.backend_id, {
      status: 'ready', family: row.family, capabilities: [row.capability], summary: 'Will run',
      detail: `Through ${row.title}.`, missing: [], backendId: row.backend_id, templateId: `library-${row.workflow_id}`,
    });
  }
  return out;
}

const ids = z.object({ id: z.string().uuid() });
const backendQuery = z.object({ backendId: z.string().uuid() });
const addBody = z.object({ backendId: z.string().uuid(), name: z.string().min(1), version: z.string().min(1),
  capability: z.enum(['txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale']) });

export default async function addedWorkflowRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { backendId?: string } }>(
    '/models/:id/workflow-suggestions', { onRequest: [app.requireAuth] }, async (req, reply) => {
      const params = ids.safeParse(req.params), q = backendQuery.safeParse(req.query);
      if (!params.success || !q.success) return reply.code(400).send({ message: 'Choose a model and machine.' });
      const found = await modelOn(params.data.id, q.data.backendId);
      if (!found) return reply.code(404).send({ message: 'This machine does not report holding the model.' });
      const { model, backend } = found;
      const added = await query<{ workflow_id: string }>('SELECT workflow_id FROM model_added_workflows WHERE model_id = $1 ORDER BY added_at', [model.id]);
      const addedStates = (await Promise.all(added.map((row) => addedState(model.id, row.workflow_id)))).filter((s): s is AddedWorkflow => !!s);
      const canAdd = req.user?.role === 'admin';
      const base = { family: model.base_model, canAdd, added: addedStates, suggestions: [] as unknown[], version: null as string | null };
      if (!canAdd || model.type !== 'checkpoint') return base;

      let catalogue;
      try { catalogue = await workflowLibrary.catalogue(backend.id, backend.base_url); }
      catch { return base; }
      const taken = new Set((await query<{ library_name: string }>(
        `SELECT w.library_name FROM model_added_workflows a JOIN imported_workflows w ON w.id = a.workflow_id WHERE a.model_id = $1`,
        [model.id])).map((row) => row.library_name));
      const ranked = rankLibraryEntries(catalogue.entries, { filename: model.filename, family: model.base_model })
        .filter((candidate) => !taken.has(candidate.entry.name)).slice(0, CHECK_AT_MOST);
      const checked = await Promise.all(ranked.map(async ({ entry, capability }) => {
        try {
          const { assessment } = await addedDeps.prepare({ backendId: backend.id, name: entry.name, version: catalogue.version,
            capability, family: model.base_model ?? familyForEntry(entry), enableFirstFrame: capability === 'img2vid', checkpoint: model.filename });
          const downloadable = assessment.status !== 'needs-files' || assessment.missingFiles.length === assessment.reasons.length;
          if (!ADDABLE.has(assessment.status) || !downloadable) return null;
          return { name: entry.name, title: entry.title, capability, downloadBytes: assessment.status === 'needs-files' ? assessment.downloadBytes : 0,
            files: assessment.missingFiles.map((file) => file.name) };
        } catch { return null; }
      }));
      return { ...base, version: catalogue.version, suggestions: checked.filter(Boolean).slice(0, SHOW_AT_MOST) };
    });

  app.post<{ Params: { id: string } }>('/models/:id/workflows/add', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const params = ids.safeParse(req.params), body = addBody.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: 'Choose a model, machine and workflow.' });
    const found = await modelOn(params.data.id, body.data.backendId);
    if (!found) return reply.code(404).send({ message: 'This machine does not report holding the model.' });
    const { model } = found;
    try {
      const catalogue = await workflowLibrary.catalogue(found.backend.id, found.backend.base_url);
      const entry = catalogue.entries.find((item) => item.name === body.data.name);
      if (!entry) return reply.code(404).send({ message: 'No such workflow.' });
      // The import is filed under the model's family, so the job path
      // (`findImported`) finds it; a model with none takes the library's name.
      const family = model.base_model ?? familyFromCatalogueBase(entry.models[0]) ?? familyForEntry(entry);
      const { converted, mapping, assessment } = await addedDeps.prepare({ ...body.data, family,
        enableFirstFrame: body.data.capability === 'img2vid', checkpoint: model.filename });
      if (!ADDABLE.has(assessment.status)) return reply.code(422).send({ message: assessment.reasons.join(' ') || 'This workflow cannot be added.' });
      const imported = await addedDeps.saveImport({ library_name: entry.name, library_version: body.data.version,
        workflow_date: entry.date, title: entry.title, description: entry.description,
        thumbnail: entry.thumbnail[0] ? `/api/workflow-library/${body.data.backendId}/thumbnail/${encodeURIComponent(entry.name)}` : null,
        capability: body.data.capability, family, graph: converted.graph, ...mapping, source_backend_id: body.data.backendId }, req.user!.id);
      if (!model.base_model) await query('UPDATE models SET base_model = $2 WHERE id = $1 AND base_model IS NULL', [model.id, family]);

      let operationId: string | null = null;
      if (assessment.status === 'needs-files') {
        const files = await Promise.all(assessment.missingFiles.map((file) => addedDeps.verifiedFile(file)));
        const operation = await addedDeps.planOperation({ backendId: body.data.backendId, workflowId: imported.id, modelId: model.id,
          actorId: req.user!.id, steps: files.map((file) => ({ kind: 'download' as const, request: { url: file.url, path: `${file.directory}/${file.name}`, sha256: file.sha256, sizeBytes: file.sizeBytes } })) });
        operationId = operation?.id ?? null;
      }
      await query(`INSERT INTO model_added_workflows (model_id, workflow_id, backend_id, operation_id, added_by)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (model_id, workflow_id) DO NOTHING`, [model.id, imported.id, body.data.backendId, operationId, req.user!.id]);
      // The person pressed Add: that is the confirmation the download needs.
      if (operationId) await addedDeps.startOperation(operationId);
      return reply.code(201).send({ added: await addedState(model.id, imported.id) });
    } catch (error) {
      return reply.code(422).send({ message: (error as Error).message });
    }
  });

  app.get<{ Params: { id: string; workflowId: string } }>('/models/:id/workflows/added/:workflowId', { onRequest: [app.requireAuth] }, async (req, reply) => {
    if (!ids.safeParse(req.params).success || !z.string().uuid().safeParse(req.params.workflowId).success) return reply.code(400).send({ message: 'Invalid workflow.' });
    const added = await addedState(req.params.id, req.params.workflowId);
    return added ? { added } : reply.code(404).send({ message: 'Not added for this model.' });
  });

  app.delete<{ Params: { id: string; workflowId: string } }>('/models/:id/workflows/added/:workflowId', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    if (!ids.safeParse(req.params).success || !z.string().uuid().safeParse(req.params.workflowId).success) return reply.code(400).send({ message: 'Invalid workflow.' });
    await query('DELETE FROM model_added_workflows WHERE model_id = $1 AND workflow_id = $2', [req.params.id, req.params.workflowId]);
    // The import was made for this model alone; with no link left it goes too.
    await query(`DELETE FROM imported_workflows w WHERE w.id = $1
      AND NOT EXISTS (SELECT 1 FROM model_added_workflows a WHERE a.workflow_id = w.id)`, [req.params.workflowId]);
    return reply.code(204).send();
  });
}
