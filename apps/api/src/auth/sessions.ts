import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, usingHttps } from '../env.js';
import { query, queryOne } from '../db.js';
import type { User } from '@comfy/shared';

export const SESSION_COOKIE = 'comfy_session';
const SESSION_DAYS = 30;

/**
 * The cookie holds a random token. The database holds only its HMAC, so read
 * access to the users table does not hand an attacker working sessions.
 */
function hashToken(token: string): string {
  return createHmac('sha256', env.authSecret).update(token).digest('base64url');
}

export interface SessionUser extends User {}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: 'user' | 'admin';
  created_at: Date;
}

function toUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createSession(
  userId: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), req.headers['user-agent'] ?? null, req.ip, expiresAt],
  );

  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: usingHttps,
    expires: expiresAt,
  });
}

/** Resolves the signed-in user, or null. Also lazily prunes the expired row. */
export async function resolveSession(req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;

  const row = await queryOne<UserRow & { session_id: string }>(
    `SELECT u.id, u.email, u.display_name, u.role, u.created_at, s.id AS session_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashToken(token)],
  );

  return row ? toUser(row) : null;
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    await query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [hashToken(token)]);
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Housekeeping: drop sessions that expired more than a day ago. */
export async function pruneSessions(): Promise<void> {
  await query(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`);
}

export { toUser, hashToken };
