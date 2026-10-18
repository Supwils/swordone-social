import { z } from 'zod';
import { ROUND_ID_RE } from '../../../contract/ingest';

/** `:roundId` in the §3 format; `findRound` additionally rejects an impossible date. */
export const roundIdParam = z.object({ roundId: z.string().regex(ROUND_ID_RE) });
