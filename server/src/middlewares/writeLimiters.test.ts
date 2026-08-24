import { describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

// Every limiter becomes a pass-through whose function name identifies it, so a
// test can assert WHICH bucket a route composes without running the real store.
vi.mock('./rateLimit', () => {
  const passthrough = (name: string) => {
    const fn = (_req: unknown, _res: unknown, next: () => void) => next();
    Object.defineProperty(fn, 'name', { value: name });
    return fn;
  };
  const names = [
    'globalLimiter',
    'loginLimiter',
    'registerLimiter',
    'passwordChangeLimiter',
    'apiKeyLimiter',
    'postWriteLimiter',
    'commentWriteLimiter',
    'messageWriteLimiter',
    'socialActionLimiter',
    'snapshotIngestLimiter',
    'labReadLimiter',
    'searchLimiter',
    'eventIngestLimiter',
  ];
  return Object.fromEntries(names.map((n) => [n, passthrough(n)]));
});

vi.mock('./auth', () => ({
  requireUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  optionalUser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { postsBookmarkRouter } from '../modules/bookmarks/bookmarks.routes';
import { notificationsRouter } from '../modules/notifications/notifications.routes';
import { usersRouter } from '../modules/users/users.routes';

function stackNames(router: Router, path: string, method: string): string[] {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.map((s) => s.handle.name);
}

describe('per-user limiters on authenticated writes', () => {
  it.each([
    ['post', 'bookmark a post'],
    ['delete', 'remove a bookmark'],
  ])('meters the bookmark toggle (%s) like its like-toggle twin', (method) => {
    // `POST/DELETE /posts/:id/bookmark` is the same shape as the like toggle,
    // which carries socialActionLimiter on all four of its routes. These two
    // had none, so a looping agent could hammer them unmetered.
    expect(stackNames(postsBookmarkRouter, '/', method)).toContain('socialActionLimiter');
  });

  it('meters marking notifications read and clearing them', () => {
    expect(stackNames(notificationsRouter, '/read', 'post')).toContain('socialActionLimiter');
    expect(stackNames(notificationsRouter, '/', 'delete')).toContain('socialActionLimiter');
  });

  it('meters the avatar upload BEFORE multer buffers the file', () => {
    // The only other multipart write, POST /posts, is metered. Here the order
    // is the point: a limiter after `upload.single` would still buffer 5 MB
    // into the process heap and pay for the S3 PUT before rejecting.
    const names = stackNames(usersRouter, '/me/avatar', 'put');
    expect(names).toContain('postWriteLimiter');
    const limiterAt = names.indexOf('postWriteLimiter');
    const multerAt = names.findIndex((n) => n === 'multerMiddleware' || n.includes('multer'));
    expect(limiterAt).toBeGreaterThanOrEqual(0);
    if (multerAt >= 0) expect(limiterAt).toBeLessThan(multerAt);
  });
});
