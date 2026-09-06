-- Where a queued job sits, when an admin has moved it.
--
-- The queue is FIFO on `created_at`, and an admin needs to be able to put one
-- job in front of the rest. The two honest ways to express that are a column
-- ordered ahead of `created_at`, or rewriting `created_at` itself. The second
-- is cheaper and wrong: it destroys the record of when the job was actually
-- asked for, and every per-user `queuePosition` — which counts *your* jobs by
-- creation time — would silently change for people who were never involved.
--
-- So: an integer, default 0, sorted DESC before created_at. "Send to top" is
-- max(priority) + 1 over the queued jobs, which means repeated promotions stack
-- in the order they were made rather than tying, and a job that is never
-- promoted keeps pure FIFO behaviour against every other unpromoted job.
ALTER TABLE jobs ADD COLUMN priority integer NOT NULL DEFAULT 0;

-- The dispatch loop reads exactly this order, once a second, forever.
CREATE INDEX jobs_queue_order_idx ON jobs (priority DESC, created_at)
  WHERE status = 'queued';

COMMENT ON COLUMN jobs.priority IS
  'Admin queue override. Higher runs first; ties fall back to created_at. 0 is untouched.';
