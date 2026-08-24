import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../lib/id';

/**
 * Drives the REAL router stack — multer (with its image/video fileFilter),
 * the zod validate layer, and the error handler — with the controller and
 * auth/limiter middlewares mocked. This is where the "wrong file type must be
 * a 400, not a 500" contract lives (see the note inside posts.routes.ts).
 */
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  search: vi.fn(),
  showcase: vi.fn(),
  translation: vi.fn(),
}));

vi.mock('./posts.controller', () => mocks);
vi.mock('../../middlewares/auth', () => ({
  requireUser: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'viewer-id', isAgent: false };
    next();
  },
  optionalUser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../middlewares/rateLimit', () => ({
  postWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  searchLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  translateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { postsRouter } from './posts.routes';
import { errorHandler } from '../../middlewares/errorHandler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/posts', postsRouter);
  app.use(errorHandler);
  return app;
}

function respond(status = 200) {
  return (_req: unknown, res: { status: (s: number) => { json: (b: unknown) => void } }) => {
    res.status(status).json({ ok: true });
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('posts routes — upload filter and stack composition', () => {
  it('accepts a multipart post with an image and reaches the controller', async () => {
    mocks.create.mockImplementation(respond(201));

    await request(makeApp())
      .post('/posts')
      .field('text', 'hello with a picture')
      .attach('images', Buffer.from('png-bytes'), {
        filename: 'a.png',
        contentType: 'image/png',
      })
      .expect(201);

    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('accepts a video attachment through the same filter', async () => {
    mocks.create.mockImplementation(respond(201));

    await request(makeApp())
      .post('/posts')
      .field('text', 'clip attached')
      .attach('video', Buffer.from('mp4-bytes'), {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
      })
      .expect(201);

    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('answers 400 (never 500) for a non-media file', async () => {
    const res = await request(makeApp())
      .post('/posts')
      .field('text', 'sneaky')
      .attach('images', Buffer.from('plain text'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/image or video/i);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a fifth image as a client error, not a server fault', async () => {
    let req = request(makeApp()).post('/posts').field('text', 'too many');
    for (let i = 0; i < 5; i += 1) {
      req = req.attach('images', Buffer.from(`img-${i}`), {
        filename: `img-${i}.png`,
        contentType: 'image/png',
      });
    }
    const res = await req;

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('validates the id param before getById / update / remove run', async () => {
    const app = makeApp();
    mocks.getById.mockImplementation(respond());
    mocks.update.mockImplementation(respond());
    mocks.remove.mockImplementation(respond());

    await request(app).get('/posts/not-hex').expect(400);
    await request(app).patch('/posts/not-hex').send({ text: 'x' }).expect(400);
    await request(app).delete('/posts/not-hex').expect(400);
    expect(mocks.getById).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();

    const id = newId();
    await request(app).get(`/posts/${id}`).expect(200);
    await request(app).patch(`/posts/${id}`).send({ text: 'edited' }).expect(200);
    await request(app).delete(`/posts/${id}`).expect(200);
    expect(mocks.getById).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it('serves search and showcase to anonymous callers', async () => {
    const app = makeApp();
    mocks.search.mockImplementation(respond());
    mocks.showcase.mockImplementation(respond());

    await request(app).get('/posts/search?q=compilers').expect(200);
    await request(app).get('/posts/showcase').expect(200);
    expect(mocks.search).toHaveBeenCalledOnce();
    expect(mocks.showcase).toHaveBeenCalledOnce();
  });
});
