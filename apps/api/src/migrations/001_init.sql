-- Initial schema: accounts, sessions, backends, models, jobs, assets.
-- Append-only: to change any of this, add a new migration file.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- accounts

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  email_lower    text GENERATED ALWAYS AS (lower(email)) STORED,
  password_hash  text NOT NULL,
  display_name   text,
  role           text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Sign-in is case-insensitive; the display form of the address is preserved.
CREATE UNIQUE INDEX users_email_lower_key ON users (email_lower);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Only the hash is stored, so a database leak does not hand out live sessions.
  token_hash  text NOT NULL UNIQUE,
  user_agent  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- ---------------------------------------------------------------- backends

CREATE TABLE backends (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  base_url     text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  status       text NOT NULL DEFAULT 'unknown'
                 CHECK (status IN ('online', 'offline', 'unknown')),
  vram_free    bigint,
  vram_total   bigint,
  -- Raw /system_stats payload, kept for the admin screen.
  system_info  jsonb,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- models

CREATE TABLE models (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL CHECK (type IN
                  ('checkpoint', 'lora', 'vae', 'controlnet', 'upscaler', 'clip', 'video')),
  -- The filename ComfyUI knows it by. Unique per type across the fleet.
  filename      text NOT NULL,
  display_name  text NOT NULL,
  base_model    text,
  preview_url   text,
  size_bytes    bigint,
  source        text NOT NULL DEFAULT 'local'
                  CHECK (source IN ('local', 'civitai', 'huggingface')),
  source_ref    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX models_type_filename_key ON models (type, filename);

-- Which backends actually hold the file on disk. Refreshed by the poller.
CREATE TABLE model_backends (
  model_id    uuid NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  backend_id  uuid NOT NULL REFERENCES backends (id) ON DELETE CASCADE,
  seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, backend_id)
);

-- ---------------------------------------------------------------- uploads

-- A file the user dropped, before it belongs to any job. Reference images and
-- video first frames both start life here.
CREATE TABLE uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  storage_key   text NOT NULL,
  thumb_key     text,
  mime_type     text NOT NULL,
  width         integer NOT NULL,
  height        integer NOT NULL,
  size_bytes    bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX uploads_user_id_idx ON uploads (user_id, created_at DESC);

-- ---------------------------------------------------------------- jobs

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN
                     ('txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale')),
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN
                     ('queued', 'dispatched', 'running', 'uploading',
                      'complete', 'failed', 'cancelled')),
  -- The GenerationParams the client sent, validated and normalised.
  params           jsonb NOT NULL,
  -- Which workflow template compiled this job, for reproducibility.
  template_id      text,
  backend_id       uuid REFERENCES backends (id) ON DELETE SET NULL,
  -- ComfyUI's own id for the queued prompt, used to reconcile after a restart.
  comfy_prompt_id  text,
  progress         jsonb NOT NULL DEFAULT '{}'::jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

CREATE INDEX jobs_user_created_idx ON jobs (user_id, created_at DESC);
-- Partial index: the orchestrator only ever scans for work still in flight.
CREATE INDEX jobs_active_idx ON jobs (created_at)
  WHERE status IN ('queued', 'dispatched', 'running', 'uploading');
CREATE INDEX jobs_comfy_prompt_idx ON jobs (comfy_prompt_id)
  WHERE comfy_prompt_id IS NOT NULL;


-- ---------------------------------------------------------------- assets

CREATE TABLE assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid REFERENCES jobs (id) ON DELETE SET NULL,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('image', 'video')),
  storage_key  text NOT NULL,
  thumb_key    text,
  width        integer NOT NULL,
  height       integer NOT NULL,
  duration     real,
  size_bytes   bigint,
  starred      boolean NOT NULL DEFAULT false,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assets_user_created_idx ON assets (user_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX assets_job_idx ON assets (job_id);

-- Input images for a job, resolved to concrete storage at dispatch time.
CREATE TABLE job_references (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN
                 ('init', 'style', 'composition', 'face', 'depth', 'pose',
                  'first-frame', 'last-frame')),
  influence    real NOT NULL DEFAULT 1.0,
  -- Exactly one of these is set: an existing generation, or a fresh upload.
  asset_id     uuid REFERENCES assets (id) ON DELETE SET NULL,
  upload_id    uuid REFERENCES uploads (id) ON DELETE SET NULL,
  position     integer NOT NULL DEFAULT 0
);

CREATE INDEX job_references_job_idx ON job_references (job_id, position);

-- ---------------------------------------------------------------- collections

CREATE TABLE collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collections_user_idx ON collections (user_id);

CREATE TABLE collection_assets (
  collection_id  uuid NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  asset_id       uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, asset_id)
);
