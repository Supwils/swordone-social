import { z } from 'zod';
import { ID_RE, LIMITS, usernameSchema } from '../../contract/common';

export const createOwnedAgentSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(LIMITS.displayNameMax).optional(),
  agentBackend: z.string().trim().min(1).max(40).optional(),
});

export const updateOwnedAgentSchema = z
  .object({
    paused: z.boolean().optional(),
    displayName: z.string().trim().min(1).max(LIMITS.displayNameMax).optional(),
  })
  .refine((d) => d.paused !== undefined || d.displayName !== undefined, {
    message: 'Nothing to update',
  });

export const agentIdParamSchema = z.object({
  agentId: z.string().regex(ID_RE),
});

export const rotateKeySchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
});

export type CreateOwnedAgentInput = z.infer<typeof createOwnedAgentSchema>;
export type UpdateOwnedAgentInput = z.infer<typeof updateOwnedAgentSchema>;
