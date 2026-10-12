import { z } from 'zod';

/**
 * Fail-fast environment validation. The process refuses to boot on a missing or
 * malformed secret rather than starting in a half-configured state and
 * failing confusingly at request time.
 */

const durationRe = /^\d+(ms|s|m|h|d)$/;

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  WEB_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:4000'),
  API_PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  OTP_PEPPER: z.string().min(16, 'OTP_PEPPER must be at least 16 chars'),
  PII_ENCRYPTION_KEY: z.string().min(32, 'PII_ENCRYPTION_KEY must be at least 32 chars'),

  ACCESS_TOKEN_TTL: z.string().regex(durationRe).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanish.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  EMAIL_FROM: z.string().default('Naijaproperty <no-reply@naijaproperty.ng>'),

  TERMII_API_KEY: z.string().default(''),
  TERMII_BASE_URL: z.string().default(''),
  TERMII_WHATSAPP_FROM: z.string().default(''),
  TERMII_SMS_FROM: z.string().default('Naijaproperty'),
  TERMII_WEBHOOK_SECRET: z.string().default(''),

  /** Seconds to wait for a WhatsApp delivery webhook before spending SMS. */
  OTP_SMS_FALLBACK_DELAY_SECONDS: z.coerce.number().int().min(5).max(120).default(20),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default('naijaproperty-media'),
  R2_PUBLIC_URL: z.string().default(''),
  R2_ENDPOINT: z.string().default(''),

  /**
   * Dev-only. When R2 is not configured, image URLs are served from generated
   * placeholder files in the web app's public directory so the browse surface
   * stays navigable. Must stay empty in production — see media-url.ts.
   */
  DEMO_MEDIA_BASE_URL: z.string().default(''),

  CLOUDFLARE_ACCOUNT_ID: z.string().default(''),
  CLOUDFLARE_STREAM_TOKEN: z.string().default(''),
  /**
   * Webhook signing secret from the Cloudflare Stream dashboard.
   *
   * Separate from the API token on purpose: the API token is sent outbound on
   * every upload, this one is only ever used to verify inbound callbacks. Rotating
   * one does not invalidate the other.
   *
   * Without it, video uploads can never be confirmed: the browser PUTs bytes
   * straight to Cloudflare, so the only signal that encoding finished is this
   * callback. Leaving it empty keeps the webhook closed rather than open, because
   * an unverified endpoint that can mark a video READY is a way to publish
   * anything on the site.
   */
  CLOUDFLARE_STREAM_WEBHOOK_SECRET: z.string().default(''),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TURNSTILE_SECRET_KEY: z.string().default(''),

  SEED_ADMIN_EMAIL: z.string().default(''),
  SEED_ADMIN_PASSWORD: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the required values.',
    );
  }

  cached = parsed.data;
  return cached;
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

/**
 * Fails loudly in production when an integration is unconfigured, so a missing
 * Termii key is caught at boot rather than at 2am during an OTP request.
 */
export function assertConfigured(feature: 'termii' | 'email' | 'google' | 'r2' | 'stream'): void {
  const env = getEnv();
  const problems: string[] = [];

  if (feature === 'termii') {
    if (!env.TERMII_API_KEY) problems.push('TERMII_API_KEY');
    if (!env.TERMII_BASE_URL) problems.push('TERMII_BASE_URL');
    if (!env.TERMII_WHATSAPP_FROM) problems.push('TERMII_WHATSAPP_FROM');
  }
  if (feature === 'email' && !env.SMTP_HOST) problems.push('SMTP_HOST');
  if (feature === 'google' && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET))
    problems.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  if (feature === 'r2' && (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY))
    problems.push('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY');
  if (feature === 'stream' && !env.CLOUDFLARE_STREAM_TOKEN)
    problems.push('CLOUDFLARE_STREAM_TOKEN');

  if (problems.length && isProduction()) {
    throw new Error(
      `Cannot boot in production: ${feature} is not configured. Missing: ${problems.join(', ')}`,
    );
  }
}
