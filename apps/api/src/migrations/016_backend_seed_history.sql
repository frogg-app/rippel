-- Remember bootstrap names after their backend is renamed or removed.
CREATE TABLE backend_seed_history (
  name text PRIMARY KEY,
  seeded_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO backend_seed_history (name) SELECT name FROM backends;
