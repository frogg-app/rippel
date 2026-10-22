-- Which library workflow was added for which model, from the model's own
-- panel. The import itself stays an immutable revision in imported_workflows;
-- this row is the link a person made, so a model can list, add and remove its
-- workflows, and a later Library view can list every link.
CREATE TABLE IF NOT EXISTS model_added_workflows (
  model_id     uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  workflow_id  uuid NOT NULL REFERENCES imported_workflows(id) ON DELETE CASCADE,
  backend_id   uuid REFERENCES backends(id) ON DELETE SET NULL,
  operation_id uuid REFERENCES model_operations(id) ON DELETE SET NULL,
  added_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, workflow_id)
);
CREATE INDEX IF NOT EXISTS model_added_workflows_workflow_idx ON model_added_workflows (workflow_id);
