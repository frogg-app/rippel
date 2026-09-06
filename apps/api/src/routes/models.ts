import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db.js';
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
});

export default async function modelRoutes(app: FastifyInstance) {
  app.get('/models', { onRequest: [app.requireAuth] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: 'Bad filter.' });
    }
    const { type, availableOnly } = parsed.data;

    const rows = await query<ModelRow>(
      `SELECT m.id, m.type, m.filename, m.display_name, m.base_model,
              m.preview_url, m.size_bytes, m.source, m.source_ref,
              array_remove(array_agg(mb.backend_id), NULL) AS backend_ids
         FROM models m
         LEFT JOIN model_backends mb ON mb.model_id = m.id
         LEFT JOIN backends b ON b.id = mb.backend_id
        WHERE ($1::text IS NULL OR m.type = $1)
          AND ($2::boolean IS NOT TRUE OR b.status = 'online')
        GROUP BY m.id
        ORDER BY m.type, m.display_name`,
      [type ?? null, availableOnly ?? false],
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

    return { models };
  });
}
