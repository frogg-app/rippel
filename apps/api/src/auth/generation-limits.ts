import type { PoolClient } from 'pg';
export class UserRestrictionError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
/** Call inside the same transaction as the job INSERT. The user row lock
 * serializes admissions, so concurrent requests cannot exceed a quota. */
export async function reserveGeneration(client: PoolClient, userId: string, batchSize: number) {
  const { rows: [user] } = await client.query<{
    suspended: boolean; generation_enabled: boolean; max_queued_jobs: number | null; daily_generation_limit: number | null;
  }>('SELECT suspended, generation_enabled, max_queued_jobs, daily_generation_limit FROM users WHERE id=$1 FOR UPDATE', [userId]);
  if (!user || user.suspended || !user.generation_enabled) throw new UserRestrictionError(403, 'generation_restricted', 'Generation is disabled for this account. Contact an administrator.');
  if (user.max_queued_jobs !== null) {
    const { rows: [usage] } = await client.query<{ count: string }>("SELECT count(*) AS count FROM jobs WHERE user_id=$1 AND status = 'queued'", [userId]);
    if (Number(usage!.count) >= user.max_queued_jobs) throw new UserRestrictionError(429, 'queued_job_limit', `Your limit is ${user.max_queued_jobs} queued jobs. Wait for one to start or cancel a queued job.`);
  }
  const { rows: [daily] } = await client.query<{ submitted: string }>("SELECT submitted FROM user_generation_usage WHERE user_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date", [userId]);
  if (user.daily_generation_limit !== null && Number(daily?.submitted ?? 0) + batchSize > user.daily_generation_limit) {
    throw new UserRestrictionError(429, 'daily_generation_limit', `This request exceeds your daily limit of ${user.daily_generation_limit} generations. The limit resets at midnight UTC.`);
  }
  await client.query(`INSERT INTO user_generation_usage(user_id,day,submitted) VALUES ($1,(now() AT TIME ZONE 'UTC')::date,$2)
    ON CONFLICT(user_id,day) DO UPDATE SET submitted=user_generation_usage.submitted+excluded.submitted`, [userId, batchSize]);
}
