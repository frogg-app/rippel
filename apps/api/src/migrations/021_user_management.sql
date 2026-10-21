ALTER TABLE users
  ADD COLUMN settings_access boolean NOT NULL DEFAULT false,
  ADD COLUMN suspended boolean NOT NULL DEFAULT false,
  ADD COLUMN generation_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN max_active_jobs integer CHECK (max_active_jobs BETWEEN 1 AND 10000),
  ADD COLUMN daily_generation_limit integer CHECK (daily_generation_limit BETWEEN 1 AND 1000000);

-- Accepted submissions count even if a job is later cancelled or deleted.
CREATE TABLE user_generation_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  submitted bigint NOT NULL DEFAULT 0 CHECK (submitted >= 0),
  PRIMARY KEY (user_id, day)
);
INSERT INTO user_generation_usage(user_id, day, submitted)
  SELECT user_id, (created_at AT TIME ZONE 'UTC')::date,
    sum(greatest(1, coalesce((params->>'batchSize')::int, 1)))
  FROM jobs WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  GROUP BY user_id, (created_at AT TIME ZONE 'UTC')::date;
