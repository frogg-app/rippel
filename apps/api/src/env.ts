/** Configuration, read once at boot. Every knob is an env var — see .env.example. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. See .env.example.`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

/**
 * Backends are seeded from `COMFY_BACKENDS=name=url,name2=url2`. After first
 * boot they live in the database and this is ignored for names already present.
 */
function parseBackends(raw: string): { name: string; baseUrl: string }[] {
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) {
        throw new Error(
          `Bad COMFY_BACKENDS entry "${pair}". Expected name=url, e.g. desktop-4090=http://192.168.1.50:8188`,
        );
      }
      return {
        name: pair.slice(0, idx).trim(),
        baseUrl: pair.slice(idx + 1).trim().replace(/\/+$/, ''),
      };
    });
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: process.env.NODE_ENV === 'production',

  port: Number(optional('PORT', '4000')),
  host: optional('HOST', '0.0.0.0'),
  publicUrl: optional('PUBLIC_URL', 'http://localhost:3000'),

  authSecret: required('AUTH_SECRET'),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: optional('REDIS_URL', 'redis://redis:6379'),

  storage: {
    driver: optional('STORAGE_DRIVER', 'local') as 'local' | 's3',
    localPath: optional('STORAGE_LOCAL_PATH', '/data/assets'),
    s3Endpoint: optional('S3_ENDPOINT', ''),
    s3Bucket: optional('S3_BUCKET', ''),
    s3AccessKey: optional('S3_ACCESS_KEY', ''),
    s3SecretKey: optional('S3_SECRET_KEY', ''),
    s3Region: optional('S3_REGION', 'us-east-1'),
  },

  backends: parseBackends(optional('COMFY_BACKENDS', '')),

  allowRegistration: bool('ALLOW_REGISTRATION', true),
  adminEmail: optional('ADMIN_EMAIL', ''),
  adminPassword: optional('ADMIN_PASSWORD', ''),

  civitaiApiKey: optional('CIVITAI_API_KEY', ''),
  huggingfaceToken: optional('HUGGINGFACE_TOKEN', ''),
} as const;

/** True when the public URL is https, which decides the cookie's Secure flag. */
export const usingHttps = env.publicUrl.startsWith('https://');
