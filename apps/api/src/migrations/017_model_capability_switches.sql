-- Switching a capability off for one model.
--
-- `model_workflows` (011) lets an operator choose *which* template a model
-- runs on. It cannot say "not at all", and that is the thing people asked for
-- once the library started offering more than one way to use a file: an SDXL
-- checkpoint that should make images but never be handed to the generic
-- img2img graph, a Wan file whose text-to-video output is not worth the GPU
-- time, a model being kept on disk for one job type only. Removing the model
-- is not the answer — it is the only copy, and ComfyUI cannot delete it anyway.
--
-- A row here means "off". There is no `enabled` column and no row for "on",
-- for the same reason 011 has no row for "automatic": the default must be
-- what an empty table says, so a model nobody has touched behaves exactly as
-- it did before this migration, and switching back on is a DELETE rather than
-- an update that could be left half-done.
--
-- Why a table of its own rather than a nullable `template_id` on
-- `model_workflows`: a pin and a switch are independent. Switching img2vid off
-- and on again must bring back the pinned template, not forget it, so the two
-- facts live in two rows and neither write touches the other.
--
-- Enforced in `models/workflow-choice.ts`, which every job path already asks,
-- so a switched-off pairing is refused by POST /jobs, by the dispatcher and by
-- the readiness check alike. `switched_off_by` is who did it — this changes
-- what every user of a shared machine can do — and is nulled rather than
-- blocking when that user is deleted.

CREATE TABLE model_capability_switches (
  model_id        uuid NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  capability      text NOT NULL CHECK (capability IN ('txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale')),
  switched_off_by uuid REFERENCES users (id) ON DELETE SET NULL,
  switched_off_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, capability)
);
