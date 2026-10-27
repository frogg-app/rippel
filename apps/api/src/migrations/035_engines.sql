-- A deployment runs one of two engines, and its backend row says which, so the
-- poller and the dispatcher can branch without a join. Both default to ComfyUI:
-- every row that exists today is one.
ALTER TABLE backends
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'comfyui'
    CHECK (engine IN ('comfyui', 'sdcpp'));

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'comfyui'
    CHECK (engine IN ('comfyui', 'sdcpp')),
  -- The last SdcppState the agent reported, whole, for the same reason `comfy`
  -- is jsonb: shaped by the agent's version, read-mostly.
  ADD COLUMN IF NOT EXISTS sdcpp jsonb;
