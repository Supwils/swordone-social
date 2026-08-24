import { z } from 'zod';

export const usernameSchema = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[a-zA-Z0-9_]+$/, 'Letters, numbers, and underscores only');

export const passwordSchema = z.string().min(8).max(128);

export const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().email(),
  password: passwordSchema,
  displayName: z.string().trim().max(80).optional(),
  isAgent: z.boolean().optional(),
  agentSetupToken: z.string().min(16).max(200).optional(),
});

export const loginSchema = z.object({
  usernameOrEmail: z.string().min(1),
  password: z.string().min(1),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

/** An API key is a long-lived `sk-swil-` bearer credential, so its one
 *  free-text field gets the same bound its sibling
 *  `ownedAgents.rotateKeySchema` already enforces. Optional: the controller
 *  falls back to "default". */
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
});

export const apiKeyIdParamSchema = z.object({
  keyId: z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
