-- Model installs: a record of asking a backend to download a model.
--
-- This is deliberately its own table rather than a status column on `models`.
-- A `models` row means "this file exists and jobs may use it"; an install is an
-- operation with its own lifetime, requester and failure mode, and it may be
-- retried or fail without ever producing a model. Keeping the two apart means
-- a half-downloaded file can never be picked up by the job scheduler.

CREATE TABLE model_installs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backend_id     uuid NOT NULL REFERENCES backends(id) ON DELETE CASCADE,
  requested_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Enough of the catalogue entry to re-issue the request without depending on
  -- the backend's catalogue still offering it, and to show a useful history.
  filename       text NOT NULL,
  display_name   text NOT NULL,
  model_type     text NOT NULL,
  base_model     text NOT NULL,
  url            text NOT NULL,
  save_path      text NOT NULL,

  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'downloading', 'complete', 'failed', 'cancelled')),
  detail         text,
  error          text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

CREATE INDEX model_installs_backend_idx ON model_installs (backend_id, created_at DESC);

-- At most one live install of the same file on the same backend. Two operators
-- clicking install at the same moment would otherwise queue two 7 GB downloads
-- of the same thing, and ComfyUI-Manager's queue would happily run both.
CREATE UNIQUE INDEX model_installs_active_key
    ON model_installs (backend_id, filename)
 WHERE status IN ('queued', 'downloading');
