import { z } from 'zod';

/** Sweep (`-r`) or manual (`-m`) round id, e.g. `20261014T060000Z-r`. */
export const ROUND_ID_RE = /^\d{8}T\d{6}Z-[rm]$/;

/** Wire contract of `swil_agent.api.resources.post_vector`. Every key is sent; unknown = null. */
export const postVectorIngest = z.object({
  postId: z.string().min(1).max(64),
  roundId: z.string().regex(ROUND_ID_RE).nullable(),
  embedding: z.array(z.number().finite()).length(1024),
  cardSim: z.number().min(-1).max(1).nullable(),
  maxSim: z.number().min(-1).max(1).nullable(),
});

export type PostVectorIngestInput = z.infer<typeof postVectorIngest>;
