import { pool, migrate } from '../db.js';
import { refreshHuggingFaceCatalogue } from '../models/hugging-face-catalogue.js';
try {
  await migrate();
  console.log(`Cached ${await refreshHuggingFaceCatalogue(true)} Hugging Face models.`);
} finally { await pool.end(); }
