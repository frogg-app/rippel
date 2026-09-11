import { randomBytes } from 'node:crypto';
import { env } from './env.js';
import { query, queryOne, transaction } from './db.js';
import { hashPassword } from './auth/password.js';

/**
 * First-boot setup. Idempotent: re-running does nothing once things exist.
 */
export async function seed(log: (msg: string) => void = console.log): Promise<void> {
  await seedBackends(log);
  await seedAdmin(log);
}

/**
 * Bootstrap each configured name once. The history survives admin renames and
 * removals so a restart cannot undo them.
 */
async function seedBackends(log: (msg: string) => void): Promise<void> {
  for (const backend of env.backends) {
    const added = await transaction(async (client) => {
      const claimed = await client.query(
        `INSERT INTO backend_seed_history (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name`,
        [backend.name],
      );
      if (claimed.rowCount === 0) return false;
      const result = await client.query(
        `INSERT INTO backends (name, base_url)
         SELECT $1, $2 WHERE NOT EXISTS (
           SELECT 1 FROM backends WHERE name = $1 OR base_url = $2
         ) ON CONFLICT (name) DO NOTHING RETURNING id`,
        [backend.name, backend.baseUrl],
      );
      return result.rowCount !== 0;
    });
    if (added) log(`seed: registered backend ${backend.name} at ${backend.baseUrl}`);
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
