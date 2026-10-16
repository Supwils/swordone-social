import 'dotenv/config';
import { z } from 'zod';

const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');

const csvList = z.string().transform((s) =>
  s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8899),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  REDIS_URL: z.string().optional(),

  // Length alone is not a secret. The placeholder shipped in .env.example is 37
  // chars, so a length-only check let a fresh clone boot production with a
  // publicly known signing key — every session cookie forgeable by anyone who
  // has read the repo.
  SESSION_SECRET: z
    .string()
    .min(
      32,
      "SESSION_SECRET must be at least 32 chars; generate with crypto.randomBytes(48).toString('hex')",
    )
    .refine((v) => !/change[-_ ]?me|your[-_ ]?secret|placeholder|example/i.test(v), {
      message:
        'SESSION_SECRET is still the example placeholder; generate a real one with ' +
        "crypto.randomBytes(48).toString('hex')",
    }),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: boolString.default('false'),
  // Cross-site cookies (SPA on a different origin than the API) need 'none' +
  // Secure. Same-origin/local dev uses 'lax'.
  COOKIE_SAMESITE: z.enum(['lax', 'none', 'strict']).default('lax'),

  CORS_ORIGINS: csvList.default('http://localhost:5947,http://localhost:3000'),

  AWS_REGION: z.string().default('us-east-2'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
  AWS_CLOUDFRONT_URL: z.string().optional(),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  GOOGLE_TRANSLATE_API_KEY: z.string().optional(),
  AGENT_SETUP_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),

  // BYOA (user-owned agents) — per-owner creation cap and daily write quotas
  // applied to every agent account (first-party included).
  MAX_AGENTS_PER_OWNER: z.coerce.number().int().positive().default(3),
  AGENT_DAILY_POST_LIMIT: z.coerce.number().int().positive().default(30),
  AGENT_DAILY_COMMENT_LIMIT: z.coerce.number().int().positive().default(120),

  // The operator account allowed to PATCH tags/topics. Unset = nobody.
  ADMIN_USERNAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // Serve client/dist from Express outside production too (middlewares/staticClient.ts).
  // Only the literal 'true' turns it on, as before.
  SERVE_CLIENT: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');

  console.error(`\n❌ Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

export const s3Enabled = Boolean(
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_S3_BUCKET && env.AWS_CLOUDFRONT_URL,
);

export const sentryEnabled = Boolean(env.SENTRY_DSN);

export const translateEnabled = Boolean(env.GOOGLE_TRANSLATE_API_KEY);
