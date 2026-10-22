/** Admin imports always name the reviewed package version. Conversion and
 * assessment are server-side; clients cannot submit executable graphs. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ComfyClient } from '../../lib/comfy.js';
import { query, queryOne } from '../../db.js';
import { objectInfoFor } from '../../orchestrator/preflight.js';
import { filterCatalogue, workflowLibrary } from './catalogue.js';
import { convertWorkflow, type ConversionSpecs } from './convert.js';
import { mapManifest } from './manifest.js';
import { saveImport, getImported } from './store.js';
import { verifiedFile } from '../../models/download-metadata.js';
import { planOperation } from '../../models/operations.js';
import { startWorkflowTest } from './tests.js';
import { assessWorkflow } from './status.js';
import { rebindCheckpoint } from './rebind.js';

const selection = z.object({
  backendId: z.string().uuid(), name: z.string().min(1), version: z.string().min(1),
  capability: z.enum(['txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale']),
  family: z.string().min(1).max(100),
  enableFirstFrame: z.boolean().default(false),
});
async function backend(id: string) {
  return queryOne<{ id: string; base_url: string }>('SELECT id, base_url FROM backends WHERE id = $1', [id]);
}
/** `checkpoint`: load this installed file instead of the workflow's own model. */
export async function prepare(input: z.infer<typeof selection> & { checkpoint?: string }) {
  const host = await backend(input.backendId);
  if (!host) throw new Error('No such backend.');
  const catalogue = await workflowLibrary.catalogue(host.id, host.base_url);
  const entry = catalogue.entries.find((item) => item.name === input.name);
  if (!entry) throw new Error('No such workflow.');
  const source = await workflowLibrary.workflow(host.id, host.base_url, input.name, input.version);
  if (input.enableFirstFrame && input.capability === 'img2vid') {
    const firstFrames = entry.io?.inputs.filter((node) => node.nodeType === 'LoadImage') ?? [];
    if (firstFrames.length === 1 && source && typeof source === 'object' && 'nodes' in source && Array.isArray(source.nodes)) {
      const node = source.nodes.find((node) => String(node.id) === String(firstFrames[0]!.nodeId));
      if (node?.type === 'LoadImage' && node.mode === 4) node.mode = 0;
    }
  }
  const specs = await objectInfoFor(host.base_url) as ConversionSpecs;
  const converted = convertWorkflow(source, specs);
  const mapping = mapManifest(converted, specs, entry, { id: 'preview', capability: input.capability, family: input.family });
  if (input.checkpoint && !rebindCheckpoint(converted.graph, mapping, input.checkpoint)) {
    throw new Error('This workflow has no single model input to use the file with.');
  }
  const stats = await new ComfyClient(host.base_url).systemStats();
  const memoryBytes = stats.system?.ram_total === undefined ? undefined : stats.system.ram_total + Math.max(0, ...(stats.devices ?? []).map((device) => device.vram_total ?? 0));
  const assessment = assessWorkflow({ openSource: entry.openSource, graph: converted.graph,
    ...mapping, info: specs, memoryBytes, weightBytes: entry.size });
  return { entry, converted, mapping, assessment };
}
export default async function workflowLibraryRoutes(app: FastifyInstance) {
  app.get<{ Params: { backendId: string; name: string } }>('/workflow-library/:backendId/thumbnail/:name', { onRequest: [app.requireAuth] }, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.backendId).success) return reply.code(400).send();
    const host = await backend(req.params.backendId);
    if (!host) return reply.code(404).send();
    const catalogue = await workflowLibrary.catalogue(host.id,host.base_url);
    const path = catalogue.entries.find((entry) => entry.name === req.params.name)?.thumbnail[0];
    if (!path || path.split('/').some((part) => !part || part === '..') || !/^[a-zA-Z0-9_./-]+$/.test(path)) return reply.code(404).send();
    const response = await fetch(`${host.base_url}/templates/${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return reply.code(404).send();
    const type = response.headers.get('content-type') ?? '';
    if (!/^(image|video)\//.test(type)) return reply.code(404).send();
    return reply.type(type).send(Buffer.from(await response.arrayBuffer()));
  });

  app.get<{ Querystring: { backendId?: string; category?: string; tag?: string; includeCloud?: string } }>(
    '/workflow-library', { onRequest: [app.requireAdmin] }, async (req, reply) => {
      const id = z.string().uuid().safeParse(req.query.backendId);
      if (!id.success) return reply.code(400).send({ message: 'Choose a backend.' });
      const host = await backend(id.data);
      if (!host) return reply.code(404).send({ message: 'No such backend.' });
      try {
        const catalogue = await workflowLibrary.catalogue(host.id, host.base_url);
        return { version: catalogue.version, entries: filterCatalogue(catalogue, { category: req.query.category,
          tag: req.query.tag, includeCloud: req.query.includeCloud === 'true' }) };
      } catch (error) { return reply.code(502).send({ message: (error as Error).message }); }
    });
  app.get('/workflow-library/imports', { onRequest: [app.requireAdmin] }, async () => ({
    imports: await query(`SELECT w.*, coalesce((SELECT jsonb_agg(t) FROM workflow_backend_tests t WHERE t.workflow_id=w.id),'[]') AS tests
      FROM imported_workflows w ORDER BY w.created_at DESC`),
  }));
  app.post<{ Params: { id: string } }>('/workflow-library/:id/test', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const parsed = z.object({ backendId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ message: 'Choose an import and backend.' });
    try { return reply.code(202).send(await startWorkflowTest(req.params.id, parsed.data.backendId)); }
    catch (error) { return reply.code(422).send({ message: (error as Error).message }); }
  });
  app.post('/workflow-library/check', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const parsed = selection.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ message: parsed.error.issues[0]?.message });
    try {
      const { mapping, assessment } = await prepare(parsed.data);
      return { assessment, files: mapping.files, omitted: mapping.omitted };
    } catch (error) { return reply.code(422).send({ message: (error as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/workflow-library/:id/install-plan', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const body = z.object({ backendId: z.string().uuid() }).safeParse(req.body);
    if (!z.string().uuid().safeParse(req.params.id).success || !body.success) return reply.code(400).send({ message: 'Choose an import and backend.' });
    const row = await getImported(req.params.id);
    const host = await backend(body.data.backendId);
    if (!row || !host) return reply.code(404).send({ message: 'Import or backend not found.' });
    try {
      const assessment = assessWorkflow({ openSource: true, ...row, info: await objectInfoFor(host.base_url) });
      if (assessment.status !== 'needs-files') return reply.code(409).send({ message: assessment.reasons.join(' ') || 'No files need installing.' });
      if (!assessment.missingFiles.length) return reply.code(422).send({ message: 'Missing files have no library download source.' });
      const files = await Promise.all(assessment.missingFiles.map((file) => verifiedFile(file)));
      const operation = await planOperation({ backendId: host.id, workflowId: row.id, actorId: req.user!.id,
        steps: files.map((file) => ({ kind: 'download', request: { url: file.url, path: `${file.directory}/${file.name}`, sha256: file.sha256, sizeBytes: file.sizeBytes } })) });
      return { operation };
    } catch (error) { return reply.code(422).send({ message: (error as Error).message }); }
  });
  app.post('/workflow-library/import', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const parsed = selection.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ message: parsed.error.issues[0]?.message });
    try {
      const { entry, converted, mapping, assessment } = await prepare(parsed.data);
      if (assessment.status === 'cloud-only') return reply.code(422).send({ message: 'Paid cloud workflows cannot be imported.' });
      const imported = await saveImport({ library_name: entry.name, library_version: parsed.data.version,
        workflow_date: entry.date, title: entry.title, description: entry.description, thumbnail: entry.thumbnail[0] ? `/api/workflow-library/${parsed.data.backendId}/thumbnail/${encodeURIComponent(entry.name)}` : null,
        capability: parsed.data.capability, family: parsed.data.family, graph: converted.graph,
        ...mapping, source_backend_id: parsed.data.backendId }, req.user!.id);
      return reply.code(201).send({ imported, assessment });
    } catch (error) { return reply.code(422).send({ message: (error as Error).message }); }
  });
}
