-- What each job cost, and whether it died for want of memory.
--
-- These two columns are the whole storage cost of the empirical fit ledger
-- described in `orchestrator/fit.ts`, and they live on `jobs` rather than in a
-- table of their own on purpose. A finished job *is* the observation. A
-- separate table would need a write path that can silently stop running and a
-- reconciliation for the times it did, in exchange for nothing: there is
-- exactly one observation per job and it is already a row.
--
-- `size_score` is from `orchestrator/cost.ts` and is an **ordering, not a
-- measurement** — bytes as a unit, but only ever compared against other scores
-- on the same backend. Two things follow. It is nullable, because a job
-- dispatched before this shipped has none and must not be counted as a small
-- one. And it is meaningless across backends, which is why every query that
-- touches it is filtered by `backend_id`.
--
-- `oom` is stored rather than re-derived from `error` at read time. The text is
-- the backend's and can change under us with a torch upgrade; a ceiling that
-- moved because we edited a regex would be a genuinely bad surprise. Classified
-- once, at the moment of failure, by `orchestrator/failure.ts`. NULL means the
-- job has not failed, or failed before this column existed — never "we checked
-- and it was not an OOM", which is `false`.

ALTER TABLE jobs
  ADD COLUMN size_score bigint  CHECK (size_score IS NULL OR size_score >= 0),
  ADD COLUMN oom        boolean;

-- The ledger reads one backend's brackets on every readiness check, so the two
-- aggregates it wants should not walk that backend's whole job history.
CREATE INDEX jobs_fit_evidence_idx
  ON jobs (backend_id, size_score)
  WHERE size_score IS NOT NULL AND (status = 'complete' OR status = 'failed');
