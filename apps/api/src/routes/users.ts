import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { ManagedUser } from '@comfy/shared';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { hashPassword } from '../auth/password.js';
interface UserRow {
  id: string; email: string; display_name: string | null; role: 'user' | 'admin'; settings_access: boolean;
  suspended: boolean; generation_enabled: boolean; max_queued_jobs: number | null; daily_generation_limit: number | null;
  created_at: Date; queued_jobs?: string; active_jobs?: string; generations_today?: string;
}
const columns = 'id,email,display_name,role,settings_access,suspended,generation_enabled,max_queued_jobs,daily_generation_limit,created_at';
function managedUser(row: UserRow): ManagedUser {
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role, settingsAccess: row.settings_access,
    suspended: row.suspended, generationEnabled: row.generation_enabled, maxQueuedJobs: row.max_queued_jobs,
    dailyGenerationLimit: row.daily_generation_limit, createdAt: row.created_at.toISOString(),
    queuedJobs: Number(row.queued_jobs ?? 0), activeJobs: Number(row.active_jobs ?? 0), generationsToday: Number(row.generations_today ?? 0) };
}
const limits = z.object({ role: z.enum(['user','admin']), settingsAccess: z.boolean(), suspended: z.boolean(),
  generationEnabled: z.boolean(), maxQueuedJobs: z.number().int().min(1).max(10000).nullable(),
  dailyGenerationLimit: z.number().int().min(1).max(1000000).nullable() }).strict();
const create = z.object({ email: z.string().trim().email().max(254), displayName: z.string().trim().max(60).optional(), password: z.string().min(1).max(200) }).strict();
class UserChangeError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function lockAdmin(client: PoolClient, actorId: string) {
  // Serialize account changes, including two admins removing each other's access.
  await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
  const { rows: [actor] } = await client.query<{ role: string; suspended: boolean }>('SELECT role,suspended FROM users WHERE id=$1', [actorId]);
  if (!actor || actor.role !== 'admin' || actor.suspended) throw new UserChangeError(403, 'Only an active administrator can manage users.');
}
export default async function userRoutes(app: FastifyInstance) {
  app.get('/users', { onRequest: [app.requireAdmin] }, async () => {
    const rows = await query<UserRow>(`SELECT ${columns.split(',').map(c => `u.${c}`).join(',')},
      (SELECT count(*) FROM jobs j WHERE j.user_id=u.id AND j.status IN ('queued','dispatched','running','uploading')) AS active_jobs,
      (SELECT count(*) FROM jobs j WHERE j.user_id=u.id AND j.status='queued') AS queued_jobs,
      coalesce((SELECT submitted FROM user_generation_usage g WHERE g.user_id=u.id AND g.day=(now() AT TIME ZONE 'UTC')::date),0) AS generations_today
      FROM users u ORDER BY u.created_at,u.id`);
    return { users: rows.map(managedUser) };
  });
  app.post('/users', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const body = create.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ message: 'Enter a valid email, display name, and password.' });
    const passwordHash = await hashPassword(body.data.password);
    try {
      const user = await transaction(async client => {
        await lockAdmin(client, req.user!.id);
        const { rows: [row] } = await client.query<UserRow>(`INSERT INTO users(email,display_name,password_hash) VALUES ($1,$2,$3) RETURNING ${columns}`, [body.data.email, body.data.displayName || null, passwordHash]);
        return managedUser(row!);
      });
      return reply.code(201).send({ user });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return reply.code(409).send({ message: 'An account with that email already exists.' });
      if (error instanceof UserChangeError) return reply.code(error.status).send({ message: error.message });
      throw error;
    }
  });
  app.delete<{ Params: { id: string } }>('/users/:id', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ message: 'Choose a valid user.' });
    if (req.params.id === req.user!.id) return reply.code(409).send({ message: 'Another administrator must delete your account.' });
    try {
      await transaction(async client => {
        await lockAdmin(client, req.user!.id);
        const { rows: [target] } = await client.query<UserRow>(`SELECT ${columns} FROM users WHERE id=$1 FOR UPDATE`, [req.params.id]);
        if (!target) throw new UserChangeError(404, 'No such user.');
        if (target.role === 'admin' && !target.suspended) {
          const { rows: [count] } = await client.query<{ n: string }>("SELECT count(*) AS n FROM users WHERE role='admin' AND NOT suspended");
          if (Number(count!.n) <= 1) throw new UserChangeError(409, 'Keep at least one active administrator.');
        }
        const { rows: active } = await client.query(`SELECT 1 FROM jobs WHERE user_id=$1 AND status IN ('queued','dispatched','running','uploading')
          UNION ALL SELECT 1 FROM model_installs WHERE requested_by=$1 AND status IN ('queued','downloading') LIMIT 1`, [target.id]);
        if (active.length) throw new UserChangeError(409, 'Wait for this user’s jobs and downloads to finish, or cancel them before deleting the account.');
        await client.query('DELETE FROM users WHERE id=$1', [target.id]);
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof UserChangeError) return reply.code(error.status).send({ message: error.message });
      throw error;
    }
  });
  app.patch<{ Params: { id: string } }>('/users/:id', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const body = limits.safeParse(req.body);
    if (!body.success || !z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ message: 'Choose valid permissions and positive limits, or leave limits blank.' });
    try {
      const user = await transaction(async client => {
        await lockAdmin(client, req.user!.id);
        const { rows: [before] } = await client.query<UserRow>(`SELECT ${columns} FROM users WHERE id=$1`, [req.params.id]);
        if (!before) throw new UserChangeError(404, 'No such user.');
        const next = body.data;
        if (before.role === 'admin' && !before.suspended && (next.role !== 'admin' || next.suspended)) {
          const { rows: [count] } = await client.query<{ n: string }>("SELECT count(*) AS n FROM users WHERE role='admin' AND NOT suspended");
          if (Number(count!.n) <= 1) throw new UserChangeError(409, 'Keep at least one active administrator.');
        }
        const { rows: [row] } = await client.query<UserRow>(`UPDATE users SET role=$2,settings_access=$3,suspended=$4,
          generation_enabled=$5,max_queued_jobs=$6,daily_generation_limit=$7,updated_at=now() WHERE id=$1 RETURNING ${columns}`,
        [before.id,next.role,next.settingsAccess,next.suspended,next.generationEnabled,next.maxQueuedJobs,next.dailyGenerationLimit]);
        if (next.suspended) await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [before.id]);
        return managedUser(row!);
      });
      return { user };
    } catch (error) {
      if (error instanceof UserChangeError) return reply.code(error.status).send({ message: error.message });
      throw error;
    }
  });
}
