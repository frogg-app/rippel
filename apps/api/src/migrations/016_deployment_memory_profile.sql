-- How hard this machine should try to fit a job in graphics memory.
--
-- Stored on the deployment rather than derived from the agent's reported
-- `comfyArgs`, and the direction matters: this column is the *intent*, and the
-- agent's argv is the consequence. Reading the intent back out of a flag string
-- would mean parsing arguments an operator may also have set by hand, and
-- guessing which of them were ours — see the note on `profileArgs` in
-- deploy/memory-profile.ts for why the string is written whole instead.
--
-- `balanced` is the default for a machine that has never been configured,
-- which matches what the panel shows before anyone touches it. It reserves a
-- gigabyte, so the desktop and the browser cannot push a job that fits in
-- isolation over the edge.
--
-- `cpu_vae` is separate from the profile because it is a different trade: the
-- decode is one big allocation at the end, and on a card that is merely tight
-- rather than too small, moving only that off it is often the whole fix. It
-- combines with any profile.

ALTER TABLE deployments
  ADD COLUMN memory_profile text NOT NULL DEFAULT 'balanced'
    CHECK (memory_profile IN ('fast', 'balanced', 'low-vram', 'minimal-vram')),
  ADD COLUMN cpu_vae boolean NOT NULL DEFAULT false;
