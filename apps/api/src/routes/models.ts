import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db.js';
import { normalizeBaseModel } from '../workflows/registry.js';
import type { Model, ModelType } from '@comfy/shared';

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
});

export default async function modelRoutes(app: FastifyInstance) {
  app.get('/models', { onRequest: [app.requireAuth] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: 'Bad filter.' });
    }
    const { type, availableOnly, baseModel } = parsed.data;
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

    return { models, families: familyRows.map((r) => r.base_model) };
  });
}
