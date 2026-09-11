-- Keep completed file-operation history when an agent-managed backend is removed.
ALTER TABLE model_operations ALTER COLUMN backend_id DROP NOT NULL;
ALTER TABLE model_operations DROP CONSTRAINT model_operations_backend_id_fkey;
ALTER TABLE model_operations ADD CONSTRAINT model_operations_backend_id_fkey
  FOREIGN KEY (backend_id) REFERENCES backends(id) ON DELETE SET NULL;
