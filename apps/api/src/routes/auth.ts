import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { query, queryOne } from '../db.js';
import { fakeVerify, hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, destroySession, toUser } from '../auth/sessions.js';

const credentials = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(254),
  password: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(200, 'That password is too long.'),
  displayName: z.string().trim().min(1).max(60).optional(),
});

const signIn = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(254),
  password: z.string().min(1).max(200),
});

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: 'user' | 'admin';
  created_at: Date;
  password_hash: string;
}

export default async function authRoutes(app: FastifyInstance) {
  /** Whether the sign-up form should be shown at all. */
  app.get('/auth/config', async () => ({
    allowRegistration: env.allowRegistration || (await isFirstUser()),
  }));

  app.post('/auth/register', async (req, reply) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: parsed.error.issues[0]?.message ?? 'Check the form and try again.',
      });
    }

    // The very first account can always be created, so a fresh install with
    // ALLOW_REGISTRATION=false is not locked out of itself.
    const firstUser = await isFirstUser();
    if (!env.allowRegistration && !firstUser) {
      return reply.code(403).send({
        error: 'registration_closed',
        message: 'Registration is closed on this server.',
      });
    }

    const { email, password, displayName } = parsed.data;
    const existing = await queryOne(`SELECT id FROM users WHERE email_lower = lower($1)`, [email]);
    if (existing) {
      return reply.code(409).send({
        error: 'email_taken',
        message: 'An account with that email already exists.',
      });
    }

    const row = await queryOne<UserRow>(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, display_name, role, created_at, password_hash`,
      [email, await hashPassword(password), displayName ?? null, firstUser ? 'admin' : 'user'],
    );
    if (!row) {
      return reply.code(500).send({ error: 'internal', message: 'Could not create the account.' });
    }

    await createSession(row.id, req, reply);
    return reply.code(201).send({ user: toUser(row) });
  });

  app.post('/auth/login', async (req, reply) => {
    const parsed = signIn.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_input', message: 'Enter your email and password.' });
    }

    const { email, password } = parsed.data;
    const row = await queryOne<UserRow>(
      `SELECT id, email, display_name, role, created_at, password_hash
         FROM users WHERE email_lower = lower($1)`,
      [email],
    );

    // Same response and roughly the same timing whether or not the account
    // exists, so this endpoint cannot be used to enumerate addresses.
    if (!row) {
      await fakeVerify();
      return reply
        .code(401)
        .send({ error: 'invalid_credentials', message: 'That email or password is not right.' });
    }

    if (!(await verifyPassword(password, row.password_hash))) {
      return reply
        .code(401)
        .send({ error: 'invalid_credentials', message: 'That email or password is not right.' });
    }

    await createSession(row.id, req, reply);
    return { user: toUser(row) };
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req, reply) => {
    if (!req.user) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Not signed in.' });
    }
    return { user: req.user };
  });
}

async function isFirstUser(): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM users) AS exists`);
  return !rows[0]?.exists;
}
