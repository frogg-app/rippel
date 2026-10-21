-- Retain the last complete upstream snapshot when Hugging Face is unavailable.
CREATE TABLE external_model_catalogues (
  source text PRIMARY KEY,
  entries jsonb NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
