/**
 * Serve the built client (`client/dist`) from the same origin as the API.
 *
 * Only active in production (or when `SERVE_CLIENT=true` is explicitly set).
 * In dev the Vite server handles the client on port 5947 and proxies `/api`
 * back to us, so we skip static mounting entirely to avoid masking route 404s.
 *
 * Mounts a SPA fallback: unknown paths that don't start with `/api/`,
 * `/auth/`, `/health`, or `/socket.io/` fall through to `index.html`.
 */
import path from 'node:path';
import fs from 'node:fs';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { env, isProd } from '../config/env';
import { logger } from '../lib/logger';

export function mountStaticClient(app: Express): void {
  const enabled = isProd || env.SERVE_CLIENT;
  if (!enabled) return;

  // Find `client/dist` from either server layout (tsc keeps `src/` inside outDir):
  //   source (tsx):  repo/server/src/middlewares/staticClient.ts      → ../../..
  //   compiled:      repo/server/dist/src/middlewares/staticClient.js → ../../../..
  // and finally from the working directory (the Docker image runs from /app).
  const candidates = [
    path.resolve(__dirname, '../../..', 'client', 'dist'),
    path.resolve(__dirname, '../../../..', 'client', 'dist'),
    path.resolve(process.cwd(), 'client', 'dist'),
  ];
  const clientDir = candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (!clientDir) {
    logger.warn(
      { tried: candidates },
      'SERVE_CLIENT/production set but client/dist not found — skipping static mount',
    );
    return;
  }

  logger.info({ clientDir }, 'serving built client from disk');

  app.use(
    express.static(clientDir, {
      // Cache hashed assets aggressively; index.html is always fresh.
      setHeaders(res, file) {
        if (/\.(?:js|css|woff2?|png|jpg|jpeg|svg|webp)$/i.test(file)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  const indexPath = path.join(clientDir, 'index.html');

  // SPA fallback — anything not handled above and not an API-ish path.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (
      req.path.startsWith('/api/') ||
      req.path.startsWith('/auth/') ||
      req.path.startsWith('/socket.io/') ||
      req.path === '/health'
    ) {
      return next();
    }
    res.sendFile(indexPath);
  });
}
