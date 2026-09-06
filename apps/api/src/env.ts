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

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}".`);
  }
  return Math.floor(n);
}

/**
 * Storage is the one setting where a typo is silently expensive — a bad value
 * would fall through to a driver that writes nowhere — so it is validated here
 * rather than at first use, which may be minutes into the first generation.
 */
function storageDriver(): 'local' | 's3' {
  const raw = optional('STORAGE_DRIVER', 'local').toLowerCase();
  if (raw !== 'local' && raw !== 's3') {
    throw new Error(`STORAGE_DRIVER must be "local" or "s3", got "${raw}".`);
  }
  return raw;
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
    driver: storageDriver(),
    localPath: optional('STORAGE_LOCAL_PATH', '/data/assets'),
    s3Endpoint: optional('S3_ENDPOINT', ''),
    s3Bucket: optional('S3_BUCKET', ''),
    s3AccessKey: optional('S3_ACCESS_KEY', ''),
    s3SecretKey: optional('S3_SECRET_KEY', ''),
    s3Region: optional('S3_REGION', 'us-east-1'),
    // MinIO and most self-hosted gateways only serve path-style URLs.
    s3ForcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
    /** Longest edge of a generated thumbnail, in pixels. */
    thumbMaxPx: int('STORAGE_THUMB_MAX_PX', 512),
    /** How long to wait for one image download from a ComfyUI backend. */
    fetchTimeoutMs: int('STORAGE_FETCH_TIMEOUT_MS', 120_000),
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

/**
 * Fail at boot rather than at the end of the first successful generation: an
 * S3 setup missing its bucket or credentials only shows up when a job finishes,
 * by which point the GPU time is already spent.
 */
export function assertStorageConfigured(): void {
  if (env.storage.driver !== 's3') return;
  const missing = (
    [
      ['S3_BUCKET', env.storage.s3Bucket],
      ['S3_ACCESS_KEY', env.storage.s3AccessKey],
      ['S3_SECRET_KEY', env.storage.s3SecretKey],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`STORAGE_DRIVER=s3 needs ${missing.join(', ')}. See .env.example.`);
  }
}
