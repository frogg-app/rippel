-- Machines rippel manages, as opposed to ComfyUI addresses it generates against.
--
-- `backends` answers "where can I send a prompt". It cannot answer "is ComfyUI
-- even installed there", "restart it", or "put the storage helper back after
-- the last update wiped custom_nodes" — all of which need a process on the far
-- machine. That process is the rippel agent, and this table is the register of
-- the machines running one.
--
-- The two tables are deliberately not merged. A ComfyUI someone started by hand
-- is a backend with no deployment, and a freshly enrolled agent that has not
-- finished installing ComfyUI yet is a deployment with no backend. `backend_id`
-- links them once both exist and goes NULL rather than cascading, because
-- removing a backend from the fleet should not un-manage the machine.
--
-- `token` is the shared secret in both directions: the agent presents it to
-- enrol and to heartbeat, and rippel presents it on every call to the agent's
-- own HTTP API. It is generated here rather than chosen, and it is the only
-- thing standing between the LAN and a remote shell, so it is 32 random bytes.

CREATE TABLE deployments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  host          text NOT NULL,
  agent_port    integer NOT NULL DEFAULT 8189
                  CHECK (agent_port > 0 AND agent_port < 65536),
  platform      text NOT NULL DEFAULT 'unknown'
                  CHECK (platform IN ('linux', 'darwin', 'win32', 'unknown')),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'online', 'offline')),
  token         text NOT NULL,
  agent_version text,
  -- The last ComfyState the agent reported, whole. Read-mostly and shaped by
  -- the agent's version, so jsonb rather than a column per field.
  comfy         jsonb,
  backend_id    uuid REFERENCES backends(id) ON DELETE SET NULL,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Names are how an operator tells two machines apart in the panel, so they are
-- unique the same way backend names are, and case-insensitively.
CREATE UNIQUE INDEX deployments_name_key ON deployments (lower(name));
-- Enrolment looks a deployment up by its token alone.
CREATE UNIQUE INDEX deployments_token_key ON deployments (token);
CREATE INDEX deployments_backend_idx ON deployments (backend_id);
