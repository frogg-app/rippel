-- Backends report memory in ways that differ per vendor and per driver, so we
-- record everything they tell us rather than reducing it to one number.
--
-- Why: ComfyUI's /system_stats reports `vram_total` as whatever the driver
-- claims. On ROCm with DynamicVRAM (and on unified-memory systems) that figure
-- pools host memory into the total — a 16 GB card can report 36 GB. There is no
-- vendor-neutral field that means "physical VRAM", so the app never claims to
-- know it: it shows what was reported, lets an operator override it, and learns
-- the real ceiling from observed failures.

ALTER TABLE backends
  ADD COLUMN device_name       text,
  ADD COLUMN ram_total         bigint,
  ADD COLUMN ram_free          bigint,
  -- Set by an admin when the reported figure is misleading. Null = trust the
  -- backend. Used as the scheduling budget when present.
  ADD COLUMN vram_limit_mb     integer,
  -- Highest pixel count this backend has actually completed for a given model,
  -- and the lowest that has OOM'd. Populated from real job outcomes.
  ADD COLUMN capability_notes  jsonb NOT NULL DEFAULT '{}'::jsonb;
