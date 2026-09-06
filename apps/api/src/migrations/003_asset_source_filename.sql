-- Make asset persistence idempotent per (job, ComfyUI output filename).
--
-- Why: the orchestrator reconciles unfinished jobs against ComfyUI's /history
-- after an API restart. A job that finished while we were down — or one whose
-- completion frame we saw *and* then re-read from history — would otherwise be
-- persisted twice, giving the user duplicate images in their library and double
-- disk use. There is no natural key for that today: `storage_key` is random by
-- design, so it can never collide.
--
-- ComfyUI names every output within a prompt uniquely (ComfyUI_00012_.png,
-- _00013_, ...), so (job_id, source_filename) identifies one produced file and
-- makes the INSERT safely repeatable via ON CONFLICT DO NOTHING.

ALTER TABLE assets
  -- The filename as ComfyUI reported it, e.g. "ComfyUI_00007_.png". Kept for
  -- provenance as well as for the uniqueness rule below.
  ADD COLUMN source_filename text,
  -- Which folder class it came out of ("output", occasionally "temp").
  ADD COLUMN source_type     text,
  -- The stored object's media type, so the read route need not guess from the
  -- extension when serving it back.
  ADD COLUMN mime_type       text;

-- Partial: rows predating this migration, and any future asset with no ComfyUI
-- origin (a direct upload promoted to an asset), have a NULL filename and are
-- simply not covered by the constraint.
CREATE UNIQUE INDEX assets_job_source_filename_key
  ON assets (job_id, source_filename)
  WHERE job_id IS NOT NULL AND source_filename IS NOT NULL;
