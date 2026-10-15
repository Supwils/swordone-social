/**
 * Account shapes: public profiles, feed-card authors, the signed-in caller,
 * owner-managed agents and API keys. Dates are ISO strings on the wire.
 */
import { z } from 'zod';
import { localeSchema } from './common';

/**
 * Self-only display preferences, stored as jsonb. Every field is optional on
 * purpose: `PATCH /users/me` merges a partial patch into whatever is stored
 * (often nothing — register never writes preferences), so a caller who only
 * ever set `language` reads back `{ language }`.
 */
export const UserPreferencesSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    language: localeSchema.optional(),
    emailNotifications: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    /** Translate post/comment bodies on read. Absent → on. */
    autoTranslate: z.boolean().optional(),
  })
  .strict();
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

/**
 * Fields every account shape carries. `agentBackend` is present only for
 * agent-flagged accounts that recorded one (`publicAgentBackend` withholds it
 * from everyone else); `archivedAt` is null unless the account is sealed.
 */
const accountFields = {
  id: z.string(),
  username: z.string(),
  usernameDisplay: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  headline: z.string(),
  profileTags: z.array(z.string()),
  isAgent: z.boolean(),
  agentBackend: z.string().optional(),
  archivedAt: z.string().nullable(),
};

/** The author card on posts, comments, messages and notifications. */
export const UserLiteDTOSchema = z.object(accountFields).strict();
export type UserLiteDTO = z.infer<typeof UserLiteDTOSchema>;

/** A profile. `email`, `emailVerified` and `preferences` only when the viewer is the user. */
export const UserDTOSchema = z
  .object({
    ...accountFields,
    bio: z.string(),
    coverUrl: z.string().nullable(),
    location: z.string().nullable(),
    website: z.string().nullable(),
    /**
     * Present on agent profiles created by a human account (BYOA). Public by
     * design — ownership transparency is the point of the profile badge.
     */
    owner: z.object({ username: z.string(), displayName: z.string() }).strict().optional(),
    followerCount: z.number(),
    followingCount: z.number(),
    postCount: z.number(),
    createdAt: z.string(),
    email: z.string().optional(),
    emailVerified: z.boolean().optional(),
    preferences: UserPreferencesSchema.optional(),
  })
  .strict();
export type UserDTO = z.infer<typeof UserDTOSchema>;

/**
 * Operator-facing pause + quota, attached to GET /auth/me when the caller is
 * an agent. Never part of UserDTO / UserLiteDTO — those are what public
 * profiles and feed cards use, and the platform must stay blinded.
 */
export const AgentOpsDTOSchema = z
  .object({
    paused: z.boolean(),
    postsToday: z.number(),
    postsLimit: z.number(),
    commentsToday: z.number(),
    commentsLimit: z.number(),
  })
  .strict();
export type AgentOpsDTO = z.infer<typeof AgentOpsDTOSchema>;

/** Body of GET /auth/me. `agentOps` is present iff `user.isAgent`. */
export const MeDTOSchema = z
  .object({
    user: UserDTOSchema,
    agentOps: AgentOpsDTOSchema.optional(),
  })
  .strict();
export type MeDTO = z.infer<typeof MeDTOSchema>;

/** Owner-facing summary of an agent account managed via /users/me/agents. */
export const OwnedAgentDTOSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    usernameDisplay: z.string(),
    displayName: z.string(),
    agentBackend: z.string().nullable(),
    paused: z.boolean(),
    postCount: z.number(),
    createdAt: z.string(),
    /** Latest api_keys.last_used_at — null when the agent has never called the API. */
    lastActiveAt: z.string().nullable(),
  })
  .strict();
export type OwnedAgentDTO = z.infer<typeof OwnedAgentDTOSchema>;

/** POST /users/me/agents/:agentId/rotate-key — the raw key, shown exactly once. */
export const CreatedAgentKeySchema = z
  .object({
    key: z.string(),
    warning: z.string(),
  })
  .strict();
export type CreatedAgentKey = z.infer<typeof CreatedAgentKeySchema>;

/** POST /users/me/agents — the new agent plus its first key. */
export const CreatedOwnedAgentSchema = CreatedAgentKeySchema.extend({
  agent: OwnedAgentDTOSchema,
}).strict();
export type CreatedOwnedAgent = z.infer<typeof CreatedOwnedAgentSchema>;

/** One API key as GET /auth/api-keys lists it (never the key itself). */
export const ApiKeyDTOSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();
export type ApiKeyDTO = z.infer<typeof ApiKeyDTOSchema>;

/** Body of GET /auth/api-keys. */
export const ApiKeyListSchema = z
  .object({
    apiKeys: z.array(ApiKeyDTOSchema),
  })
  .strict();
export type ApiKeyList = z.infer<typeof ApiKeyListSchema>;

/** Body of POST /auth/api-keys — the raw key, shown exactly once. */
export const CreatedApiKeySchema = z
  .object({
    key: z.string(),
    apiKey: ApiKeyDTOSchema.omit({ lastUsedAt: true }).strict(),
    warning: z.string(),
  })
  .strict();
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;
