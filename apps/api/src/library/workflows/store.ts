/** Imported graphs and manifests remain data. Exact companion filenames are
 * serialized as strings; reconstruct only escaped filename matchers on read. */
import type { JobKind } from '@comfy/shared';
import { query, queryOne } from '../../db.js';
import type { ComfyApiGraph, WorkflowManifest, WorkflowTemplate } from '../../workflows/types.js';
import type { WorkflowFile } from './manifest.js';

export interface ImportedWorkflow {
  id: string; library_name: string; library_version: string; workflow_date: string;
  title: string; description: string; thumbnail: string | null; capability: JobKind; family: string;
  graph: ComfyApiGraph; manifest: WorkflowManifest | null; files: WorkflowFile[]; omitted: string[];
  source_backend_id: string | null; created_at: Date;
}
export function manifestData(manifest: WorkflowManifest | null): unknown {
  if (!manifest) return null;
  return { ...manifest, requires: manifest.requires?.map((requirement) => ({ ...requirement, match: {} })) };
}
export function importedTemplate(row: ImportedWorkflow): WorkflowTemplate | undefined {
  if (!row.manifest) return;
  const manifest: WorkflowManifest = { ...row.manifest,
    id: `library-${row.id}`,
    requires: row.manifest.requires?.map((requirement) => {
      const files = requirement.preferred ?? [];
      if (!files.length) throw new Error('Imported companion has no exact filename.');
      const names = files.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      return { ...requirement, match: { filename: new RegExp(`(?:^|[\\\\/])(?:${names})$`, 'i') } };
    }),
  };
  return { manifest, graph: row.graph };
}
export interface ImportLookupInput {
  capability: JobKind; family: string | null; id?: string; backendId?: string; filename?: string | null;
}
export type ImportLookup = (input: ImportLookupInput) => Promise<WorkflowTemplate | undefined>;
export const findImported: ImportLookup = async (input) => {
  const id = input.id?.replace(/^library-/, '') ?? null;
  const rows = await query<ImportedWorkflow>(
    `SELECT w.* FROM imported_workflows w WHERE w.capability = $1
       AND lower(regexp_replace(w.family, '[^a-zA-Z0-9]', '', 'g')) = $2
       AND ($3::uuid IS NULL OR w.id = $3)
       AND w.manifest IS NOT NULL
       AND EXISTS (SELECT 1 FROM workflow_backend_tests t JOIN backends b ON b.id = t.backend_id
         WHERE t.workflow_id = w.id AND t.status = 'ready' AND b.enabled AND b.status = 'online'
           AND ($4::uuid IS NULL OR t.backend_id = $4))
       ORDER BY w.created_at DESC`,
    [input.capability, input.family?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '', id, input.backendId ?? null],
  );
  for (const row of rows) {
    const template = importedTemplate(row);
    if (!template) continue;
    // An imported workflow is tested with exact model files, not an arbitrary
    // other checkpoint that happens to share a family label.
    const binding = template.manifest.inputs.find((input) => input.source === 'checkpointFilename');
    const [nodeId, , name] = binding?.path.split('.') ?? [];
    const expected = nodeId && name ? template.graph[nodeId]?.inputs[name] : null;
    const basename = (name: string) => name.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
    if (input.filename && typeof expected === 'string' && basename(input.filename) !== basename(expected)) continue;
    return template;
  }
};

export async function readyBackendIds(templateId: string): Promise<string[]> {
  if (!templateId.startsWith('library-')) return [];
  const rows = await query<{ backend_id: string }>('SELECT backend_id FROM workflow_backend_tests WHERE workflow_id = $1 AND status = \'ready\'', [templateId.slice(8)]);
  return rows.map((row) => row.backend_id);
}
export const getImported = (id: string) => queryOne<ImportedWorkflow>('SELECT * FROM imported_workflows WHERE id = $1', [id]);
export const listImported = () => query<ImportedWorkflow>('SELECT * FROM imported_workflows ORDER BY created_at DESC');

/** Only revisions proven on an available backend may be offered to users. */
export const listReadyImports = () => query<ImportedWorkflow>(
  `SELECT w.* FROM imported_workflows w WHERE w.manifest IS NOT NULL
   AND EXISTS (SELECT 1 FROM workflow_backend_tests t JOIN backends b ON b.id = t.backend_id
     WHERE t.workflow_id = w.id AND t.status = 'ready' AND b.enabled AND b.status = 'online')
   ORDER BY w.title, w.created_at DESC`,
);

export async function saveImport(input: Omit<ImportedWorkflow, 'id' | 'created_at'>, actorId: string): Promise<ImportedWorkflow> {
  const row = await queryOne<ImportedWorkflow>(
    `INSERT INTO imported_workflows (library_name, library_version, workflow_date, title, description,
      thumbnail, capability, family, graph, manifest, files, omitted, source_backend_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14) RETURNING *`,
    [input.library_name, input.library_version, input.workflow_date, input.title, input.description,
      input.thumbnail, input.capability, input.family, JSON.stringify(input.graph), JSON.stringify(manifestData(input.manifest)),
      JSON.stringify(input.files), JSON.stringify(input.omitted), input.source_backend_id, actorId],
  );
  if (!row) throw new Error('Workflow import was not saved.');
  return row;
}
