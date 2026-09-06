-- What the compiler actually decided for a job.
--
-- `jobs.params` is what the *user* asked for, and for a random seed that is
-- literally `null`. The number they need in order to reproduce an image is the
-- one the compiler rolled at dispatch, along with the concrete filenames and
-- pixel dimensions it chose. None of that was recoverable afterwards, which
-- makes "re-run this exact image" impossible — so it is recorded here.
--
-- Kept separate from `params` rather than written back into it: overwriting the
-- request would erase the fact that the user asked for a random seed, and the
-- difference matters to the UI (a rolled seed shows a dice, a locked one does
-- not).
ALTER TABLE jobs ADD COLUMN resolved jsonb;

COMMENT ON COLUMN jobs.resolved IS
  'CompileResult.resolved: the concrete seed, dimensions, checkpoint and LoRA filenames used.';
