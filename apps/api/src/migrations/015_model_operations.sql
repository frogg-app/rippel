-- Durable plans retain the actor and every step across browser/API restarts.
CREATE TABLE model_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backend_id uuid NOT NULL REFERENCES backends(id),
  model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  workflow_id uuid REFERENCES imported_workflows(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  steps jsonb NOT NULL,
  step_index integer NOT NULL DEFAULT 0,
  agent_task_id text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','starting','done','failed')),
  progress jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX model_operation_active_backend ON model_operations (backend_id) WHERE status IN ('running','starting');
