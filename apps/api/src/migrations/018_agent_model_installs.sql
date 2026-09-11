-- Preserve which transport owns each download across server restarts.
ALTER TABLE model_installs ADD COLUMN transport_kind text NOT NULL DEFAULT 'comfyui-manager';
ALTER TABLE model_installs ADD COLUMN operation_id uuid REFERENCES model_operations(id) ON DELETE SET NULL;
