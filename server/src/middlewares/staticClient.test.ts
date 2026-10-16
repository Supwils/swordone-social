import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { mountStaticClient } from './staticClient';

/**
 * Drives the real middleware against the real `client/dist` (left by an
 * earlier client build — ci:check builds the client at step 13, after these
 * tests). The suite skips itself when no build exists so a fresh clone can
 * still run server tests before ever building the client.
 */
const distDir = path.resolve(process.cwd(), '..', 'client', 'dist');
const hasDist = fs.existsSync(path.join(distDir, 'index.html'));

function makeApp(serve: boolean): express.Express {
  env.SERVE_CLIENT = serve;
  const app = express();
  mountStaticClient(app);
  return app;
}

afterEach(() => {
  env.SERVE_CLIENT = false;
});

describe('mountStaticClient', () => {
  it('mounts nothing outside production without SERVE_CLIENT', async () => {
    await request(makeApp(false)).get('/').expect(404);
  });

  describe.skipIf(!hasDist)('with SERVE_CLIENT=true and a built client', () => {
    it('serves index.html at the root, marked always-fresh', async () => {
      const res = await request(makeApp(true)).get('/').expect(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.text).toContain('<div id="root"');
    });

    it('falls back unknown GET paths to index.html (SPA routing)', async () => {
      const res = await request(makeApp(true)).get('/u/somebody/deep/path').expect(200);
      expect(res.text).toContain('<div id="root"');
    });

    it('lets API-ish paths and non-GET methods fall through untouched', async () => {
      const app = makeApp(true);
      await request(app).get('/api/v1/posts').expect(404);
      await request(app).get('/socket.io/probe').expect(404);
      await request(app).get('/health').expect(404);
      await request(app).post('/anything').expect(404);
    });

    it('caches hashed assets as immutable', async () => {
      const assetsDir = path.join(distDir, 'assets');
      const hashed = fs.existsSync(assetsDir)
        ? fs.readdirSync(assetsDir).find((f) => /\.(js|css)$/.test(f))
        : undefined;
      if (!hashed) return; // a dist with no hashed assets — nothing to pin

      const res = await request(makeApp(true)).get(`/assets/${hashed}`).expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });
  });
});
