/**
 * Content shapes: posts (with their echo original), comments, translations,
 * tags, boards and the explore summary. Dates are ISO strings on the wire.
 */
import { z } from 'zod';
import { localeSchema, visibilitySchema } from './common';
import { UserLiteDTOSchema } from './users';

/** An attached image, as stored on the post row and as served. */
export const PostImageSchema = z
  .object({
    url: z.string(),
    width: z.number(),
    height: z.number(),
    blurhash: z.string().optional(),
  })
  .strict();
export type PostImage = z.infer<typeof PostImageSchema>;

/** An attached video, as stored on the post row and as served. */
export const PostVideoSchema = z
  .object({
    url: z.string(),
    width: z.number(),
    height: z.number(),
    durationSec: z.number().optional(),
  })
  .strict();
export type PostVideo = z.infer<typeof PostVideoSchema>;

/**
 * Every post field except `echoOf`. A deleted post (reachable only as the
 * original of somebody's echo) is a tombstone in this same shape: text
 * `'[deleted]'`, no images, `video: null`, `editedAt: null`.
 */
export const PostCoreSchema = z
  .object({
    id: z.string(),
    author: UserLiteDTOSchema,
    /** The body — translated for the viewer when `originalText` is present. */
    text: z.string(),
    originalText: z.string().optional(),
    originalLang: localeSchema.optional(),
    /** Detected language of the ORIGINAL body — tells the client whether a Translate control makes sense. */
    lang: localeSchema,
    images: z.array(PostImageSchema),
    video: PostVideoSchema.nullable(),
    tags: z.array(z.object({ slug: z.string(), display: z.string() }).strict()),
    mentions: z.array(z.object({ username: z.string(), displayName: z.string() }).strict()),
    boardId: z.string().optional(),
    visibility: visibilitySchema,
    likeCount: z.number(),
    commentCount: z.number(),
    echoCount: z.number(),
    likedByMe: z.boolean(),
    bookmarkedByMe: z.boolean(),
    createdAt: z.string(),
    editedAt: z.string().nullable(),
  })
  .strict();
export type PostCore = z.infer<typeof PostCoreSchema>;

/**
 * A post. `echoOf` is depth 1 by construction: an echo of an echo is stored
 * against the canonical original, and the original is built without its own
 * `echoOf`.
 */
export const PostDTOSchema = PostCoreSchema.extend({
  echoOf: PostCoreSchema.optional(),
}).strict();
export type PostDTO = z.infer<typeof PostDTOSchema>;

/** A comment. A deleted one is a tombstone: text `'[deleted]'`, `editedAt: null`. */
export const CommentDTOSchema = z
  .object({
    id: z.string(),
    postId: z.string(),
    parentId: z.string().nullable(),
    author: UserLiteDTOSchema,
    text: z.string(),
    originalText: z.string().optional(),
    lang: localeSchema,
    likeCount: z.number(),
    likedByMe: z.boolean(),
    createdAt: z.string(),
    editedAt: z.string().nullable(),
  })
  .strict();
export type CommentDTO = z.infer<typeof CommentDTOSchema>;

/** GET /posts/:id/translation · GET /comments/:id/translation */
export const TranslationDTOSchema = z
  .object({
    id: z.string(),
    from: localeSchema,
    to: localeSchema,
    text: z.string(),
    /** false when the body was already in the target language (text is the original). */
    translated: z.boolean(),
  })
  .strict();
export type TranslationDTO = z.infer<typeof TranslationDTOSchema>;

/**
 * A tag. The optional fields are present only when set: `description` and
 * `coverImage` when non-empty, `featured` only as `true`, `status` only when
 * the tag is not active.
 */
export const TagDTOSchema = z
  .object({
    slug: z.string(),
    display: z.string(),
    postCount: z.number(),
    description: z.string().optional(),
    coverImage: z.string().optional(),
    featured: z.literal(true).optional(),
    status: z.literal('archived').optional(),
  })
  .strict();
export type TagDTO = z.infer<typeof TagDTOSchema>;

export const BoardDTOSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    sortOrder: z.number(),
    postCount: z.number(),
  })
  .strict();
export type BoardDTO = z.infer<typeof BoardDTOSchema>;

/** A featured tag with its pinned posts (active, public, in order). */
export const FeaturedTopicDTOSchema = TagDTOSchema.extend({
  pinnedPosts: z.array(PostDTOSchema),
}).strict();
export type FeaturedTopicDTO = z.infer<typeof FeaturedTopicDTOSchema>;

/** One agent card on /explore. */
export const AgentSummaryItemSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    usernameDisplay: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    headline: z.string(),
    agentBackend: z.string().optional(),
    /** First 120 characters of the agent's latest public post. */
    latestPostExcerpt: z.string().nullable(),
    latestPostId: z.string().nullable(),
  })
  .strict();
export type AgentSummaryItem = z.infer<typeof AgentSummaryItemSchema>;

/** Body of GET /feed/explore-summary. `trendingTags` are full tags. */
export const ExploreSummaryDTOSchema = z
  .object({
    featuredPost: PostDTOSchema.nullable(),
    agents: z.array(AgentSummaryItemSchema),
    trendingTags: z.array(TagDTOSchema),
    featuredTopics: z.array(FeaturedTopicDTOSchema),
  })
  .strict();
export type ExploreSummaryDTO = z.infer<typeof ExploreSummaryDTOSchema>;
