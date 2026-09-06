import { randomBytes } from 'node:crypto';
import { env } from './env.js';
import { query, queryOne } from './db.js';
import { hashPassword } from './auth/password.js';

/**
 * First-boot setup. Idempotent: re-running does nothing once things exist.
 */
export async function seed(log: (msg: string) => void = console.log): Promise<void> {
  await seedBackends(log);
  await seedAdmin(log);
}

/**
 * Backends named in COMFY_BACKENDS are inserted if the name is new. An existing
 * backend is left alone — once it is in the database, the admin UI owns it, and
 * silently rewriting a URL someone changed by hand would be surprising.
 */
async function seedBackends(log: (msg: string) => void): Promise<void> {
  for (const backend of env.backends) {
    const existing = await queryOne(`SELECT id FROM backends WHERE name = $1`, [backend.name]);
    if (existing) continue;
    await query(`INSERT INTO backends (name, base_url) VALUES ($1, $2)`, [
      backend.name,
      backend.baseUrl,
    ]);
    log(`seed: registered backend ${backend.name} at ${backend.baseUrl}`);
  }
}

/**
 * Creates the admin account from ADMIN_EMAIL/ADMIN_PASSWORD when both are set.
 * When they are not, the first person to register becomes the admin — and we
 * print that clearly rather than leaving a fresh install looking broken.
 */
async function seedAdmin(log: (msg: string) => void): Promise<void> {
  const anyUser = await queryOne(`SELECT id FROM users LIMIT 1`);
  if (anyUser) return;

  if (!env.adminEmail) {
    log('');
    log('  No accounts yet, and ADMIN_EMAIL is not set.');
    log(`  Open ${env.publicUrl} and register — the first account becomes the administrator.`);
    log('');
    return;
  }

  const password = env.adminPassword || randomBytes(12).toString('base64url');
  await query(
    `INSERT INTO users (email, password_hash, role, display_name)
     VALUES ($1, $2, 'admin', $3)`,
    [env.adminEmail, await hashPassword(password), 'Administrator'],
  );

  log('');
  log(`  Created administrator ${env.adminEmail}`);
  if (!env.adminPassword) {
    log(`  Generated password: ${password}`);
    log('  This is shown once. Change it after signing in.');
  }
  log('');
}
