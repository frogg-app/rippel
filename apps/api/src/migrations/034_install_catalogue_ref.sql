-- The catalogue entry an install was started from. Several entries can share
-- a filename (re-uploads of the same weights), so the filename alone told
-- every one of them it was downloading. Null on rows from before this.
ALTER TABLE model_installs ADD COLUMN IF NOT EXISTS catalogue_ref TEXT;
