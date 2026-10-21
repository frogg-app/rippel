-- A model page's tags, sorted into groups (models/tags.ts).
--
-- Stored as `group:value` keys — "task:text-to-image", "base:black-forest-labs/
-- flux.1-dev", "tag:photorealistic" — rather than HuggingFace's raw `tags[]`,
-- because the raw list is mostly plumbing (`region:us`, `endpoints_compatible`)
-- and every reader would have to strip it again. One flat array of keys rather
-- than a column per group so "has all of these and none of those" is a single
-- `@>` / `&&` against one GIN index, whatever groups the filter mixes.
--
-- NULL means "never fetched with tags", which is every row written before this
-- migration: metadata.ts treats that as stale, so the ordinary sweep fills the
-- column in on the next catalogue read without a backfill here. An empty array
-- means "fetched, and the page has none" — the two must not be confused or the
-- sweep would re-read tagless repos forever.
ALTER TABLE model_catalogue_meta ADD COLUMN IF NOT EXISTS tags text[];

CREATE INDEX IF NOT EXISTS model_catalogue_meta_tags_idx
  ON model_catalogue_meta USING GIN (tags);
