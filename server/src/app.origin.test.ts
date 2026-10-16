/**
 * The origin rule over the real middleware stack (cors → csrf), not each
 * middleware alone. CORS ran first and had no same-host branch, so a write from
 * a same-origin deploy (Express serving the SPA, origin = its own host) was a
 * CORS 403 before the CSRF guard's same-host branch could ever run.
 *
 * `POST /auth/login` with an empty body is the probe: it fails validation (400)
 * before any DB read, so "not 403" means the origin passed both layers.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { env } from './config/env';

const LOGIN = '/api/v1/auth/login';

describe('origin rule over the app stack', () => {
  it('passes a same-host write whose origin is not on CORS_ORIGINS', async () => {
    const res = await request(createApp())
      .post(LOGIN)
      .set('Host', 'swil.example')
      .set('Origin', 'https://swil.example')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('passes an allowlisted cross-origin write with credentialed CORS headers (split deploy)', async () => {
    const origin = env.CORS_ORIGINS[0];
    const res = await request(createApp())
      .post(LOGIN)
      .set('Host', 'api.example.com')
      .set('Origin', origin)
      .send({});
    expect(res.status).toBe(400);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('answers an allowlisted preflight', async () => {
    const origin = env.CORS_ORIGINS[0];
    const res = await request(createApp())
      .options(LOGIN)
      .set('Host', 'api.example.com')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
  });

  it('rejects a disallowed cross-origin request with 403, reads included', async () => {
    const app = createApp();
    const write = await request(app)
      .post(LOGIN)
      .set('Host', 'api.example.com')
      .set('Origin', 'https://evil.example')
      .send({});
    expect(write.status).toBe(403);
    expect(write.headers['access-control-allow-origin']).toBeUndefined();

    const read = await request(app)
      .get('/health')
      .set('Host', 'api.example.com')
      .set('Origin', 'https://evil.example');
    expect(read.status).toBe(403);
  });

  it('passes a request with no Origin (agent runtime, MCP, curl)', async () => {
    const res = await request(createApp()).post(LOGIN).send({});
    expect(res.status).toBe(400);
  });
});
