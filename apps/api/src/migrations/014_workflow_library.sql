-- Imports are immutable revisions. Re-import creates a new id so old jobs
-- retain their graph and package version. Readiness belongs to a backend.
CREATE TABLE imported_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_name text NOT NULL,
  library_version text NOT NULL,
  workflow_date text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  thumbnail text,
  capability text NOT NULL CHECK (capability IN ('txt2img','img2img','txt2vid','img2vid','upscale')),
  family text NOT NULL,
  graph jsonb NOT NULL,
  manifest jsonb,
  files jsonb NOT NULL DEFAULT '[]',
  omitted jsonb NOT NULL DEFAULT '[]',
  source_backend_id uuid REFERENCES backends(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workflow_backend_tests (
  workflow_id uuid NOT NULL REFERENCES imported_workflows(id) ON DELETE CASCADE,
  backend_id uuid NOT NULL REFERENCES backends(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','testing','ready','failed')),
  prompt_id text,
  result jsonb,
  tested_at timestamptz,
  PRIMARY KEY (workflow_id, backend_id)
);
CREATE INDEX workflow_ready_idx ON workflow_backend_tests (workflow_id, backend_id) WHERE status = 'ready';
