import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok } from '../../lib/respond';
import { toBoardDTO } from '../../lib/dto';
import { LIMITS } from '../../contract/common';
import { getBoardBySlug, listBoards } from './boards.service';

export const boardsRouter = Router();

const slugParams = z.object({ slug: z.string().min(1).max(LIMITS.slug) });

boardsRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const items = await listBoards();
    return ok(res, { items: items.map(toBoardDTO) });
  }),
);

boardsRouter.get(
  '/:slug',
  validate(slugParams, 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    const board = await getBoardBySlug(req.params.slug);
    return ok(res, toBoardDTO(board));
  }),
);
