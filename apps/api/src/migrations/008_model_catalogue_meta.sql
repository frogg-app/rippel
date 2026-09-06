-- Cached third-party facts about catalogue entries, and their preview images.
--
-- ComfyUI-Manager's catalogue is 372 rows of filename + size, which is not
-- enough to choose between 145 checkpoints. Everything richer has to come from
-- the model *page* an entry references (HuggingFace for 368 of those 372), and
-- that costs two or three HTTPS round trips per repo. Doing it per request
-- would make the Discover tab unusable; doing it in memory would redo the whole
-- lot on every restart. So it is a table.
--
-- Keyed by `source_key` — "hf:<owner>/<repo>", "civitai:<id>" — rather than by
-- catalogue ref, because ~372 entries collapse onto ~132 repos: eleven GGUF
-- quantisations of FLUX share one model page, one licence and one picture.
--
-- The image bytes live here too, in the column rather than in object storage.
-- They are downscaled to a 640x360 WebP first (~30 kB each, tens of MB for a
-- whole catalogue), and the alternative — the browser fetching huggingface.co
-- once per tile — is exactly what must not happen: it leaks who is browsing
-- what to a third party and breaks entirely on a LAN with no egress.
CREATE TABLE IF NOT EXISTS model_catalogue_meta (
  -- "hf:stabilityai/stable-diffusion-xl-base-1.0"
  source_key      text PRIMARY KEY,
  -- URL-safe, stable, and short: this is the id in the preview route, so it
  -- must not contain the slash a repo name does.
  preview_id      text NOT NULL UNIQUE,
  reference_url   text NOT NULL,

  license         text,
  downloads       bigint,
  likes           integer,
  pipeline_tag    text,

  -- The third-party URL the picture was taken from, kept for provenance and so
  -- a later refresh can tell "nothing changed" from "we picked a new file".
  preview_source  text,
  -- Set when the picture belongs to the model this one is derived from (a
  -- quantisation, a distillation): the repo id we borrowed it from.
  preview_borrowed_from text,
  preview_bytes   bytea,
  preview_type    text,

  -- Null on success. Held rather than discarded so a repo that 404s or is
  -- gated is not retried on every page load; see METADATA_RETRY_MS.
  error           text,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);

-- The refresh sweep asks "what is stale or has never been tried", in that order.
CREATE INDEX IF NOT EXISTS model_catalogue_meta_fetched_idx
  ON model_catalogue_meta (fetched_at);
