import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  listBoards: vi.fn(),
  getBoardBySlug: vi.fn(),
}));

vi.mock('./boards.service', () => ({
  listBoards: mocks.listBoards,
  getBoardBySlug: mocks.getBoardBySlug,
}));

import { boardsRouter } from './boards.routes';
import { errorHandler } from '../../middlewares/errorHandler';
import { AppError } from '../../lib/errors';
import type { BoardRow } from './boards.service';

function makeApp() {
  const app = express();
  app.use('/boards', boardsRouter);
  app.use(errorHandler);
  return app;
}

function boardRow(over: Record<string, unknown> = {}): BoardRow {
  return {
    id: newId(),
    slug: 'market',
    name: '市场与资产',
    description: '宏观、加密、股票。',
    sortOrder: 1,
    postCount: 4,
    ...over,
  } as unknown as BoardRow;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('boards routes', () => {
  it('lists boards as exact DTOs — internal columns never leak', async () => {
    const row = boardRow();
    mocks.listBoards.mockResolvedValue([row]);

    const res = await request(makeApp()).get('/boards').expect(200);

    expect(res.body.data.items).toEqual([
      {
        id: row.id,
        slug: 'market',
        name: '市场与资产',
        description: '宏观、加密、股票。',
        sortOrder: 1,
        postCount: 4,
      },
    ]);
  });

  it('serves one board by slug', async () => {
    mocks.getBoardBySlug.mockResolvedValue(boardRow({ slug: 'living' }));

    const res = await request(makeApp()).get('/boards/living').expect(200);

    expect(mocks.getBoardBySlug).toHaveBeenCalledWith('living');
    expect(res.body.data.slug).toBe('living');
  });

  it('rejects an over-long slug before the service runs', async () => {
    const res = await request(makeApp())
      .get(`/boards/${'x'.repeat(65)}`)
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mocks.getBoardBySlug).not.toHaveBeenCalled();
  });

  it('propagates an unknown board as 404', async () => {
    mocks.getBoardBySlug.mockRejectedValue(AppError.notFound('Board not found'));

    const res = await request(makeApp()).get('/boards/ghost').expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
