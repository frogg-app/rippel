/**
 * Workflows per model: browse the templates, see which apply to a model and
 * how each would fare on a backend, pin one, and remove a model.
 *
 *   GET    /workflows/templates          every template, for browsing    auth
 *   GET    /models/:id/workflows         options + verdicts for one model auth
 *   PUT    /models/:id/workflows         pin or unpin one per capability  admin
 *   DELETE /models/:id                   remove the model                 admin
 *
 * The verdicts are the same `runnabilityFor` the Installed list and the
 * catalogue use, run once per template instead of once per family, so what
 * the sheet says about a graph is exactly what the row would say if that
 * graph were the only one.
 *
 * Removal is honest about its limits. ComfyUI exposes no route that deletes
 * a model file and ComfyUI-Manager has none either, so `deleteBackendFile`
 * below is a hook that refuses until something on the backend can act: the
 * rippel storage helper (tools/comfyui-rippel-storage) is scoped to rippel's
 * own input/output subfolders and will gain a model-folder mode. Until then
 * the record is removed and the response says the file stayed — and, since
 * the backend poller re-lists whatever it finds on disk, that the row will
 * come back on the next scan unless the file is deleted on the machine.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  JobKind,
  ModelRemoval,
  ModelRunnability,
  ModelType,
  ModelWorkflowOption,
  ModelWorkflows,
  Uuid,
  WorkflowTemplateSummary,
} from '@comfy/shared';
import { query as defaultQuery, queryOne as defaultQueryOne } from '../db.js';
import { env } from '../env.js';
import { HelperError, makeStorageHelper } from '../backends/storage.js';
import type { ObjectInfo } from '../lib/comfy.js';
import { objectInfoFor as defaultObjectInfoFor } from '../orchestrator/preflight.js';
import { folderOfInstalled, loaderFolderOf, loaderFoldersOf } from '../workflows/folders.js';
import {
  TEMPLATES,
  findTemplateById,
  knownCapabilities,
  templatesFor,
} from '../workflows/registry.js';
import type { WorkflowTemplate } from '../workflows/types.js';
import { folderForType } from './installs.js';
import { runnabilityFor } from './runnability.js';
import { chooseTemplate, overrideFor, type OverrideLookup } from './workflow-choice.js';

// ---------------------------------------------------------------- summaries

const CAPABILITY_WORDS: Record<JobKind, string> = {
  txt2img: 'Makes an image from a prompt',
  img2img: 'Reworks a starting image from a prompt',
  txt2vid: 'Makes a clip from a prompt',
  img2vid: 'Animates a starting image',
  upscale: 'Enlarges an image',
};

/** One sentence per template: what it does, for whom, from where. */
export function describeTemplate(template: WorkflowTemplate): string {
  const { manifest } = template;
  const what = CAPABILITY_WORDS[manifest.capability];
  const folder = loaderFolderOf(template);
  const from = folder ? `, loading the model from ${folder}/` : '';
  const companions = (manifest.requires ?? []).map((r) => r.label.toLowerCase());
  const needs = companions.length > 0 ? `; needs ${companions.join(' and ')}` : '';
  const kind = manifest.isFallback
    ? 'on the generic Stable Diffusion node set — a best guess for a family nobody has authored a graph for'
    : `on a graph written for ${manifest.baseModels[0] ?? 'this family'}`;
  return `${what} ${kind}${from}${needs}.`;
}

export function templateSummary(template: WorkflowTemplate): WorkflowTemplateSummary {
  const { manifest } = template;
  return {
    id: manifest.id,
    version: manifest.version,
    label: manifest.label,
    capability: manifest.capability,
    baseModels: [...manifest.baseModels],
    isFallback: manifest.isFallback === true,
    loaderFolder: loaderFolderOf(template),
    loaderFolders: loaderFoldersOf(template),
    requires: (manifest.requires ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      modelType: r.modelType,
      why: r.why,
    })),
    requiredNodeClasses: [...manifest.requiredNodeClasses],
    description: describeTemplate(template),
  };
}

// ---------------------------------------------------------------- deps

export interface WorkflowDb {
  query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  queryOne: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
}

export class BackendFileDeletionUnsupported extends Error {
  constructor(backendName: string, reason?: string) {
    super(
      reason ??
        `${backendName} cannot delete model files: ComfyUI and ComfyUI-Manager expose no route ` +
          'for it. Install the comfyui-rippel-storage helper there and set COMFY_STORAGE_TOKEN, ' +
          'or delete the file on that machine by hand.',
    );
    this.name = 'BackendFileDeletionUnsupported';
  }
}

/**
 * Delete one model file from a backend's disk.
 *
 * ComfyUI cannot do this itself, so it goes through the comfyui-rippel-storage
 * helper (tools/comfyui-rippel-storage) when a token is configured and the
 * helper answers. Every other case — no token, helper not installed, token
 * mismatch, backend down — throws `BackendFileDeletionUnsupported` with the
 * reason, and the caller reports the file as still on disk.
 */
export async function deleteBackendFile(
  backendUrl: string,
  folder: string,
  filename: string,
  backendName = 'This backend',
): Promise<void> {
  const token = env.comfyStorageToken;
  if (!token) throw new BackendFileDeletionUnsupported(backendName);
  const helper = makeStorageHelper({ token });
  try {
    await helper.removeModel(backendUrl, folder, filename);
  } catch (cause) {
    if (cause instanceof HelperError) {
      const why =
        cause.state === 'missing'
          ? `${backendName} does not have the comfyui-rippel-storage helper installed.`
          : cause.state === 'unauthorised'
            ? `${backendName}: the storage token is not set there, or does not match.`
            : cause.state === 'not-found'
              ? `${backendName}: ${folder}/${filename} was not on disk.`
              : `${backendName} did not answer.`;
      throw new BackendFileDeletionUnsupported(backendName, why);
    }
    throw cause;
  }
}

export interface WorkflowRouteDeps {
  db?: WorkflowDb;
  objectInfoFor?: (baseUrl: string) => Promise<ObjectInfo>;
  lookupOverride?: OverrideLookup;
  deleteBackendFile?: typeof deleteBackendFile;
}

interface ModelRow extends Record<string, unknown> {
  id: string;
  display_name: string;
  filename: string;
  base_model: string | null;
  type: ModelType;
  backend_ids: string[] | null;
}

interface BackendRow extends Record<string, unknown> {
  id: string;
  name: string;
  base_url: string;
  status: string;
}

const CAPABILITIES = ['txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale'] as const;

const assignBody = z.object({
  capability: z.enum(CAPABILITIES),
  templateId: z.string().min(1).max(64).nullable(),
});

// ---------------------------------------------------------------- routes

export function makeWorkflowRoutes(deps: WorkflowRouteDeps = {}) {
  const db: WorkflowDb = deps.db ?? {
    query: defaultQuery as WorkflowDb['query'],
    queryOne: defaultQueryOne as WorkflowDb['queryOne'],
  };
  const objectInfoFor = deps.objectInfoFor ?? defaultObjectInfoFor;
  const lookupOverride: OverrideLookup =
    deps.lookupOverride ??
    (deps.db
      ? async (modelId, capability) => {
          const row = await db.queryOne<{ template_id: string }>(
            'SELECT template_id FROM model_workflows WHERE model_id = $1 AND capability = $2',
            [modelId, capability],
          );
          return row?.template_id ?? null;
        }
      : overrideFor);
  const removeFile = deps.deleteBackendFile ?? deleteBackendFile;

  async function modelOr404(id: string, reply: FastifyReply): Promise<ModelRow | null> {
    const row = await db.queryOne<ModelRow>(
      `SELECT m.id, m.display_name, m.filename, m.base_model, m.type,
              array_remove(array_agg(mb.backend_id), NULL) AS backend_ids
         FROM models m
         LEFT JOIN model_backends mb ON mb.model_id = m.id
        WHERE m.id = $1
        GROUP BY m.id`,
      [id],
    );
    if (!row) await reply.code(404).send({ error: 'not_found', message: 'No such model.' });
    return row;
  }

  async function assignedFor(modelId: string): Promise<Partial<Record<JobKind, string>>> {
    const rows = await db.query<{ capability: JobKind; template_id: string }>(
      'SELECT capability, template_id FROM model_workflows WHERE model_id = $1',
      [modelId],
    );
    const out: Partial<Record<JobKind, string>> = {};
    for (const row of rows) {
      // A pin naming a template the registry no longer ships is not an
      // assignment; it is a stale row, reported as automatic.
      if (findTemplateById(row.template_id)) out[row.capability] = row.template_id;
    }
    return out;
  }

  return async function workflowRoutes(app: FastifyInstance) {
    app.get('/workflows/templates', { onRequest: [app.requireAuth] }, async () => ({
      templates: TEMPLATES.map(templateSummary),
    }));

    app.get<{ Params: { id: string }; Querystring: { backendId?: string } }>(
      '/models/:id/workflows',
      { onRequest: [app.requireAuth] },
      async (req, reply) => {
        const model = await modelOr404(req.params.id, reply);
        if (!model) return;

        // The backend to judge against: the one asked for, else the first
        // online one that holds the file, else none (static verdicts only).
        const holding = model.backend_ids ?? [];
        let backend: BackendRow | null = null;
        if (req.query.backendId) {
          backend = await db.queryOne<BackendRow>(
            'SELECT id, name, base_url, status FROM backends WHERE id = $1',
            [req.query.backendId],
          );
          if (!backend) {
            return reply.code(404).send({ error: 'not_found', message: 'No such backend.' });
          }
        } else if (holding.length > 0) {
          backend = await db.queryOne<BackendRow>(
            `SELECT id, name, base_url, status FROM backends
              WHERE id = ANY($1::uuid[]) AND status = 'online'
              ORDER BY name LIMIT 1`,
            [holding],
          );
        }

        let info: ObjectInfo | null = null;
        if (backend && backend.status === 'online') {
          try {
            info = await objectInfoFor(backend.base_url);
          } catch {
            info = null;
          }
        }

        const folder = folderOfInstalled(info, model.filename);
        const assigned = await assignedFor(model.id);
        const installedHere = backend ? holding.includes(backend.id) : false;

        const options: ModelWorkflowOption[] = [];
        for (const capability of knownCapabilities()) {
          const candidates = templatesFor(capability, model.base_model);
          if (candidates.length === 0) continue;
          const automatic = await chooseTemplate({
            modelId: null,
            capability,
            family: model.base_model,
            filename: model.filename,
            info,
          });
          for (const template of candidates) {
            const verdict: ModelRunnability = runnabilityFor({
              filename: model.filename,
              type: model.type,
              catalogueBase: model.base_model,
              folder,
              info,
              backendId: backend?.id ?? null,
              backendName: backend?.name ?? 'the backend',
              installed: installedHere,
              templates: [template],
            });
            options.push({
              template: templateSummary(template),
              verdict,
              automatic: automatic?.template.manifest.id === template.manifest.id,
              assigned: assigned[capability] === template.manifest.id,
            });
          }
        }

        const body: ModelWorkflows = {
          model: {
            id: model.id as Uuid,
            displayName: model.display_name,
            filename: model.filename,
            family: model.base_model,
            folder,
          },
          backend: backend ? { id: backend.id as Uuid, name: backend.name } : null,
          assigned,
          options,
        };
        return body;
      },
    );

    app.put<{ Params: { id: string }; Body: unknown }>(
      '/models/:id/workflows',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const model = await modelOr404(req.params.id, reply);
        if (!model) return;

        const parsed = assignBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'invalid_input',
            message: 'Send { capability, templateId } — templateId null to go back to automatic.',
          });
        }
        const { capability, templateId } = parsed.data;

        if (templateId === null) {
          await db.query('DELETE FROM model_workflows WHERE model_id = $1 AND capability = $2', [
            model.id,
            capability,
          ]);
          return { assigned: await assignedFor(model.id) };
        }

        const template = findTemplateById(templateId);
        if (!template) {
          return reply.code(404).send({ error: 'not_found', message: `No template called "${templateId}".` });
        }
        if (template.manifest.capability !== capability) {
          return reply.code(400).send({
            error: 'invalid_input',
            message: `"${templateId}" is a ${template.manifest.capability} template, not ${capability}.`,
          });
        }
        // Only a template that could serve this family may be pinned. Pinning
        // an SDXL graph onto an LTX file would dispatch a job that fails a
        // minute in; refusing here is the cheaper failure.
        const applicable = templatesFor(capability, model.base_model).some(
          (candidate) => candidate.manifest.id === templateId,
        );
        if (!applicable) {
          return reply.code(400).send({
            error: 'invalid_input',
            message: `"${template.manifest.label}" is not written for ${model.base_model ?? 'an unknown'} models.`,
          });
        }

        await db.query(
          `INSERT INTO model_workflows (model_id, capability, template_id, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (model_id, capability) DO UPDATE
             SET template_id = EXCLUDED.template_id, updated_at = now()`,
          [model.id, capability, templateId],
        );
        return { assigned: await assignedFor(model.id) };
      },
    );

    app.delete<{ Params: { id: string } }>(
      '/models/:id',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const model = await modelOr404(req.params.id, reply);
        if (!model) return;

        const holding = model.backend_ids ?? [];
        const backends =
          holding.length > 0
            ? await db.query<BackendRow>(
                'SELECT id, name, base_url, status FROM backends WHERE id = ANY($1::uuid[])',
                [holding],
              )
            : [];

        // Try the disk first, per backend. Today this always refuses — see the
        // hook — and the refusal is reported rather than hidden.
        const kept: string[] = [];
        let removedFromDisk = backends.length > 0;
        for (const backend of backends) {
          let info: ObjectInfo | null = null;
          try {
            info = backend.status === 'online' ? await objectInfoFor(backend.base_url) : null;
          } catch {
            info = null;
          }
          const folder = folderOfInstalled(info, model.filename) ?? folderForType(model.type) ?? 'checkpoints';
          try {
            await removeFile(backend.base_url, folder, model.filename, backend.name);
          } catch (err) {
            removedFromDisk = false;
            kept.push(
              err instanceof BackendFileDeletionUnsupported
                ? `${backend.name} (${folder}/${model.filename})`
                : `${backend.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        await db.query('DELETE FROM models WHERE id = $1', [model.id]);

        const removal: ModelRemoval = {
          removed: true,
          removedFromDisk,
          note: removedFromDisk
            ? null
            : kept.length > 0
              ? `The record is gone, but the file is still on ${kept.join(' and ')}. ` +
                'ComfyUI has no route that deletes a model, so delete it on that machine by hand; ' +
                'until then the next scan of that backend will list the model again.'
              : 'The record is gone. No backend reported holding the file.',
        };
        return { removal };
      },
    );
  };
}

export default makeWorkflowRoutes();
