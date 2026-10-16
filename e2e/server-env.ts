/**
 * The complete environment the e2e API server is started with. Kept in its own
 * dependency-free module so playwright.config.ts uses it and a server vitest
 * (src/config/e2eEnv.test.ts) can prove EnvSchema accepts exactly this and
 * nothing else — CI has no server/.env to fill gaps.
 */
export function e2eServerEnv(opts: {
  databaseUrl: string;
  serverPort: number;
  clientPort: number;
}): Record<string, string> {
  return {
    E2E_DATABASE_URL: opts.databaseUrl,
    DATABASE_URL: opts.databaseUrl,
    PORT: String(opts.serverPort),
    NODE_ENV: 'development',
    // Test-only value (>= 32 chars, not a placeholder); never used outside e2e.
    SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef0123456789abcdef',
    // Browsers attach an Origin header to (even same-origin) POSTs; the
    // server's CORS allowlist must include the e2e client port.
    CORS_ORIGINS: `http://localhost:${opts.clientPort},http://127.0.0.1:${opts.clientPort}`,
    // dotenv does not override existing vars, so blanking these keeps a local
    // server/.env from leaking real integrations (Sentry, Translate, S3, Redis) into e2e.
    REDIS_URL: '',
    COOKIE_DOMAIN: '',
    COOKIE_SECURE: 'false',
    COOKIE_SAMESITE: 'lax',
    SENTRY_DSN: '',
    GOOGLE_TRANSLATE_API_KEY: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    AWS_S3_BUCKET: '',
    AWS_CLOUDFRONT_URL: '',
  };
}
