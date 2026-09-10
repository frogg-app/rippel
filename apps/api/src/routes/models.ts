import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db.js';
import { folderOfInstalled } from '../workflows/folders.js';
import { runnabilityFor } from '../models/runnability.js';
import { objectInfoFor } from '../orchestrator/preflight.js';
import { normalizeBaseModel } from '../workflows/registry.js';
import { requireTransport } from '../models/installs.js';
import { withCatalogueInfo } from '../models/metadata.js';
import type {
  ModelCatalogEntry,
  ModelCatalogInfo,
  ModelRunnability,
  RunnabilityStatus,
  Model,
  ModelType,
  Uuid,
} from '@comfy/shared';

interface ModelRow {
  id: string;
  type: ModelType;
  filename: string;
  display_name: string;
  base_model: string | null;
  preview_url: string | null;
  size_bytes: string | null;
  source: 'local' | 'civitai' | 'huggingface';
  source_ref: string | null;
  backend_ids: string[] | null;
}

const listQuery = z.object({
  type: z
    .enum(['checkpoint', 'lora', 'vae', 'controlnet', 'upscaler', 'clip', 'video'])
    .optional(),
  /** Only models at least one online backend can actually load right now. */
  availableOnly: z.coerce.boolean().optional(),
  /**
   * One base model family, in any spelling: compared the way the workflow
   * registry compares families, so "SDXL 1.0", "sdxl" and "sd-xl-1.0" all
   * select the same models. The UI passes back a value it got from `families`.
   */
  baseModel: z.string().min(1).max(64).optional(),
  /**
   * Also work out, per model, whether it can actually be generated with — see
   * models/runnability.ts.
   *
   * Opt-in, and it is opt-in for a reason: answering means reading
   * `/object_info` off every online backend, which is a megabyte of JSON and up
   * to 20 seconds on a cold cache. The Create screen calls this route on every
   * load and must not pay for it; the Models screen asks once and wants it.
   */
  runnability: z.coerce.boolean().optional(),
  /**
   * Also match each installed file against the backend's catalogue, so the
   * Models screen can show the picture, licence and download count we already
   * hold for it.
   *
   * Opt-in for the same reason `runnability` is: answering means asking each
   * online backend's Manager for its catalogue. The Create screen calls this
   * route on every load and must not pay for it.
   */
  previews: z.coerce.boolean().optional(),
});

/**
 * Best-first, so a model that runs on one machine is reported as running even
 * if another machine is missing its text encoder. "Where it works" is the
 * useful answer; "where it does not" is a per-backend question this list does
 * not ask.
 */
const STATUS_RANK: Record<RunnabilityStatus, number> = {
  ready: 0,
  generic: 1,
  unknown: 2,
  'needs-companion': 3,
  'wrong-folder': 4,
  'no-workflow': 5,
  support: 6,
};

export default async function modelRoutes(app: FastifyInstance) {
  app.get('/models', { onRequest: [app.requireAuth] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: 'Bad filter.' });
    }
    const { type, availableOnly, baseModel, runnability, previews } = parsed.data;
    // Normalised on the way in and in SQL on the way out, so a stored "sdxl"
    // matches a requested "SDXL 1.0" — the same fold the registry does when it
    // looks a template up, and the reason the two can never disagree.
    const family = baseModel ? normalizeBaseModel(baseModel) : null;

    const rows = await query<ModelRow>(
      `SELECT m.id, m.type, m.filename, m.display_name, m.base_model,
              m.preview_url, m.size_bytes, m.source, m.source_ref,
              array_remove(array_agg(mb.backend_id), NULL) AS backend_ids
         FROM models m
         LEFT JOIN model_backends mb ON mb.model_id = m.id
         LEFT JOIN backends b ON b.id = mb.backend_id
        WHERE ($1::text IS NULL OR m.type = $1)
          AND ($2::boolean IS NOT TRUE OR b.status = 'online')
          AND ($3::text IS NULL
               OR regexp_replace(lower(m.base_model), '[^a-z0-9]', '', 'g') = $3)
        GROUP BY m.id
        ORDER BY m.type, m.display_name`,
      [type ?? null, availableOnly ?? false, family],
    );

    const models: Model[] = rows.map((row) => ({
      id: row.id,
      type: row.type,
      filename: row.filename,
      displayName: row.display_name,
      baseModel: row.base_model,
      previewUrl: row.preview_url,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      source: row.source,
      sourceRef: row.source_ref,
      backendIds: row.backend_ids ?? [],
    }));

    // The families the UI can offer as filters. Deliberately computed over the
    // type/availability filters but *not* over `baseModel`: the chips must not
    // vanish the moment one of them is clicked. Models we could not classify
    // are simply absent from this list and carry `baseModel: null`, so the UI
    // can show them under an "Unknown" heading without a special field here.
    const familyRows = await query<{ base_model: string }>(
      `SELECT DISTINCT m.base_model
         FROM models m
         LEFT JOIN model_backends mb ON mb.model_id = m.id
         LEFT JOIN backends b ON b.id = mb.backend_id
        WHERE m.base_model IS NOT NULL
          AND ($1::text IS NULL OR m.type = $1)
          AND ($2::boolean IS NOT TRUE OR b.status = 'online')
        ORDER BY m.base_model`,
      [type ?? null, availableOnly ?? false],
    );

    return {
      models,
      families: familyRows.map((r) => r.base_model),
      runnability: runnability ? await verdicts(models) : undefined,
      previews: previews ? await catalogueFacts(models, req.log) : undefined,
    };
  });
}

/**
 * What we already know about an installed file, found by matching it to the
 * catalogue entry of the same name.
 *
 * An installed model is a local file: rippel knows its filename, type and
 * family, but not which HuggingFace repo it came from, so none of the cached
 * facts in `model_catalogue_meta` — which is keyed by model *page* — can be
 * reached from it directly. The bridge is the filename. ComfyUI-Manager's
 * catalogue states a filename per entry, and `sd_xl_base_1.0.safetensors` on
 * disk is the same file as `checkpoints/SDXL/sd_xl_base_1.0.safetensors` in
 * the catalogue; matching on the basename is exactly the comparison
 * `runnability.ts` already makes between the two sides, for the same reason
 * (the install path adds a subfolder the catalogue row does not carry).
 *
 * Measured on the live box before this was written: 9 of the 10 installed
 * models match a catalogue entry and 7 already have a cached picture. The one
 * that does not — a Hunyuan Video checkpoint somebody dropped in by hand — is
 * the ordinary case this must degrade well for, and it does: no match means no
 * `info`, and the card falls back to the same family art a catalogue card with
 * no picture uses.
 *
 * **Nothing here fetches anything new.** It reads the catalogue the backend
 * already serves and joins it to metadata we already hold. A local file has no
 * reliable source URL, so there is no honest way to go and look one up, and a
 * screen that started making outbound requests per local file would be a
 * different and much worse thing than this.
 */
async function catalogueFacts(
  models: Model[],
  log: { info: (message: string) => void },
): Promise<Record<Uuid, ModelCatalogInfo>> {
  const backendIds = [...new Set(models.flatMap((model) => model.backendIds))];
  if (backendIds.length === 0) return {};

  const backends = await query<{ id: string; base_url: string }>(
    `SELECT id, base_url FROM backends WHERE id = ANY($1::uuid[]) AND status = 'online'`,
    [backendIds],
  );

  const out: Record<Uuid, ModelCatalogInfo> = {};
  for (const backend of backends) {
    let entries: ModelCatalogEntry[];
    try {
      const transport = await requireTransport(backend.base_url);
      // `withCatalogueInfo` merges the cache and kicks off a background sweep
      // for anything stale — the same call the Discover tab makes, so the two
      // screens can never disagree about a picture.
      ({ entries } = await withCatalogueInfo(await transport.catalogue(), (message) =>
        log.info(message),
      ));
    } catch (err) {
      // A backend with no Manager, or one that has gone away since the model
      // rows were written. Fail open: no pictures is the status quo — but say
      // so in the log, because "the cards lost their pictures" is otherwise
      // indistinguishable from "nothing matched".
      log.info(`installed previews: no catalogue from backend ${backend.id} (${String(err)})`);
      continue;
    }

    const byFile = new Map<string, ModelCatalogEntry>();
    for (const entry of entries) {
      const key = basename(entry.filename).toLowerCase();
      const held = byFile.get(key);
      // Two catalogue rows can name the same file — a repo and a mirror of it.
      // Prefer whichever one actually has a picture; otherwise first wins.
      if (!held || (!held.info?.previewUrl && entry.info?.previewUrl)) byFile.set(key, entry);
    }

    let matched = 0;
    for (const model of models) {
      if (out[model.id] || !model.backendIds.includes(backend.id)) continue;
      const hit = byFile.get(basename(model.filename).toLowerCase());
      if (hit) matched += 1;
      if (hit?.info) out[model.id] = hit.info;
    }
    // Cheap, once per Models-screen load, and the only way to tell "this box's
    // files are unusual" from "the join is broken" without a debugger.
    log.info(
      `installed previews: ${matched}/${models.length} matched a catalogue entry, ` +
        `${Object.keys(out).length} with cached facts, from ${byFile.size} catalogue filenames`,
    );
  }
  return out;
}

/** Last path segment, either separator: a backend may be a Windows box. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * "It is installed" and "it works" are different claims, and the installed list
 * was only ever making the first one. A checkpoint whose family has no workflow,
 * or whose text encoder nobody downloaded, sat in the list looking available.
 *
 * Verdicts are keyed by model id rather than added to `Model`, deliberately:
 * `Model` is shared with the Create screen and the orchestrator, and a field
 * that is present on one route and absent on three others is a trap.
 */
async function verdicts(models: Model[]): Promise<Record<Uuid, ModelRunnability>> {
  const backendIds = [...new Set(models.flatMap((model) => model.backendIds))];
  if (backendIds.length === 0) return {};

  const backends = await query<{ id: string; name: string; base_url: string }>(
    `SELECT id, name, base_url FROM backends WHERE id = ANY($1::uuid[]) AND status = 'online'`,
    [backendIds],
  );

  // One /object_info per backend, shared by every model on it, through
  // preflight's cache. An offline backend is simply not asked.
  const info = new Map<string, Awaited<ReturnType<typeof objectInfoFor>> | null>();
  await Promise.all(
    backends.map(async (backend) => {
      try {
        info.set(backend.id, await objectInfoFor(backend.base_url));
      } catch {
        info.set(backend.id, null);
      }
    }),
  );

  const out: Record<Uuid, ModelRunnability> = {};
  for (const model of models) {
    for (const backend of backends) {
      if (!model.backendIds.includes(backend.id)) continue;
      const verdict = runnabilityFor({
        filename: model.filename,
        type: model.type,
        // `base_model` is our own canonical spelling by this point, which the
        // catalogue-base table also understands; where it does not, inference
        // falls through to the filename exactly as it would for a new file.
        catalogueBase: model.baseModel,
        // Not derived from the row's `type`: that comes from *which loader
        // reported it*, and UNETLoader reports a diffusion_models file as a
        // checkpoint. /object_info says which loader actually lists the file,
        // and that is the folder — or null when the backend was not readable.
        folder: folderOfInstalled(info.get(backend.id) ?? null, model.filename),
        info: info.get(backend.id) ?? null,
        backendId: backend.id,
        backendName: backend.name,
        installed: true,
      });
      const held = out[model.id];
      if (!held || STATUS_RANK[verdict.status] < STATUS_RANK[held.status]) out[model.id] = verdict;
    }
  }
  return out;
}
