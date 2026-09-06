-- The name rippel gives a file on a ComfyUI box.
--
-- Every starting image is sent to a backend's input/comfy-studio/ under a
-- content-hash name: the first 32 hex characters of the SHA-256 of the stored
-- bytes, plus the extension (workflows/init-image.ts). Nothing recorded which
-- upload or asset that was, so the storage view could list a backend's inputs
-- but not say whose they were. The hash is now kept on the row.
--
-- Filled on new uploads at insert; backfilled lazily for older rows the first
-- time the storage view needs them (backends/storage.ts). Assets carry it too,
-- because a library image can be a starting image as well.

ALTER TABLE uploads ADD COLUMN content_hash text;
ALTER TABLE assets  ADD COLUMN content_hash text;

CREATE INDEX uploads_content_hash_idx ON uploads (content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX assets_content_hash_idx  ON assets  (content_hash) WHERE content_hash IS NOT NULL;

COMMENT ON COLUMN uploads.content_hash IS
  'First 32 hex chars of sha256(stored bytes): the basename ComfyUI knows the file by.';
COMMENT ON COLUMN assets.content_hash IS
  'First 32 hex chars of sha256(stored bytes), when the asset has been sent to a backend or listed there.';
