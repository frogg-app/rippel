ALTER TABLE model_catalogue_meta
  ADD COLUMN description text,
  ADD COLUMN base_models jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN tags jsonb NOT NULL DEFAULT '[]';
