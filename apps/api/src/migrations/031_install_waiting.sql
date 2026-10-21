-- Installs that wait their turn.
--
-- Installing a model now brings its missing parts (prompt reader, decoder) with
-- it. An agent backend runs one download operation at a time
-- (model_operation_active_backend), so the parts cannot all start at once: they
-- are recorded as `waiting`, linked to the install they follow, and the install
-- poller starts each one when that backend has nothing else downloading.
ALTER TABLE model_installs DROP CONSTRAINT model_installs_status_check;
ALTER TABLE model_installs ADD CONSTRAINT model_installs_status_check
  CHECK (status IN ('waiting', 'queued', 'downloading', 'complete', 'failed', 'cancelled'));

ALTER TABLE model_installs
  ADD COLUMN after_install uuid REFERENCES model_installs (id) ON DELETE SET NULL;

-- A waiting install is live for the "one at a time per file" rule too, or a
-- second click would queue the same part twice.
DROP INDEX model_installs_active_key;
CREATE UNIQUE INDEX model_installs_active_key
    ON model_installs (backend_id, filename)
 WHERE status IN ('waiting', 'queued', 'downloading');
