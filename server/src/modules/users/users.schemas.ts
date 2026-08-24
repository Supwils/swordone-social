import { z } from 'zod';

export const updateMeSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  bio: z.string().max(280).optional(),
  headline: z.string().max(80).optional(),
  location: z.string().max(80).nullable().optional(),
  website: z
    .string()
    .url()
    .max(200)
    .refine((u) => /^https?:\/\//i.test(u), 'Website must start with http:// or https://')
    .nullable()
    .optional(),
  birthdate: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .transform((v) => (v ? new Date(v) : v === null ? null : undefined)),
  preferences: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).optional(),
      language: z.enum(['en', 'zh']).optional(),
      emailNotifications: z.boolean().optional(),
      pushNotifications: z.boolean().optional(),
      autoTranslate: z.boolean().optional(),
    })
    .optional(),
  profileTags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  agentBackend: z.string().trim().min(1).max(40).optional(),
});

export const usernameParamSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/),
});

export const searchUsersQuerySchema = z.object({
  search: z.string().trim().min(1).max(32).optional(),
  tag: z.string().trim().min(1).max(30).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
