-- A second, larger rendition of each catalogue preview.
--
-- The first version of this cache stored one 640x360 WebP per model page, which
-- was right for a 244px card and wrong for what the images actually are: a
-- large share of HuggingFace model-card images are **contact sheets** — a 3x3 or
-- 4x4 grid of samples — and the sources are big (mean 2449px wide across the
-- live catalogue, up to 7955px). At 640 wide, one cell of a 4x4 grid is 160px:
-- a thumbnail of a thumbnail, which is exactly what the operator complained
-- about. Enlarging the card alone would only magnify a 640px image.
--
-- So there are two renditions, because they answer different questions:
--
--   preview_bytes       ~640px, for the tile in a grid of hundreds. Small
--                       enough that a page of 48 cards is not a download.
--   preview_full_bytes  ~1600px, fetched only when somebody clicks to enlarge
--                       one. That is where a contact sheet becomes readable.
--
-- Neither is cropped any more; the card crops with CSS, so the enlarged view
-- can still show the whole sheet. Measured cost for the whole 372-entry
-- catalogue: about 12 MB, against 1.99 MB before. Cheap for what it buys.
ALTER TABLE model_catalogue_meta ADD COLUMN IF NOT EXISTS preview_full_bytes bytea;
ALTER TABLE model_catalogue_meta ADD COLUMN IF NOT EXISTS preview_full_type text;

-- Which version of the image pipeline produced the stored bytes. Rows written
-- by an older one are re-resolved by the ordinary staleness sweep rather than
-- being deleted here: a row keeps the picture it has until a better one has
-- actually been fetched, so nobody watches a grid go blank after a deploy.
ALTER TABLE model_catalogue_meta ADD COLUMN IF NOT EXISTS preview_rev integer NOT NULL DEFAULT 0;
