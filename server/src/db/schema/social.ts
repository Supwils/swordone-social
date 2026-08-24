import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { newId } from '../../lib/id';

// --- shared jsonb payload types (TS-only; keep in sync with lib/dto.ts) ---
export type AuthProvider = { provider: 'google' | 'local'; providerId?: string };
export type UserPreferences = {
  theme: 'system' | 'light' | 'dark';
  language: 'en' | 'zh';
  emailNotifications: boolean;
  pushNotifications: boolean;
  /** Translate post/comment bodies on read. Absent → on. */
  autoTranslate?: boolean;
};
export type PostImage = { url: string; width: number; height: number; blurhash?: string };
export type PostVideo = { url: string; width: number; height: number; durationSec?: number };

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    username: text('username').notNull(),
    usernameDisplay: text('username_display').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    passwordHash: text('password_hash'),
    authProviders: jsonb('auth_providers').$type<AuthProvider[]>().notNull().default([]),

    displayName: text('display_name').notNull().default(''),
    bio: text('bio').notNull().default(''),
    headline: text('headline').notNull().default(''),
    avatarUrl: text('avatar_url'),
    coverUrl: text('cover_url'),
    location: text('location'),
    website: text('website'),
    birthdate: timestamp('birthdate', { withTimezone: true }),

    followerCount: integer('follower_count').notNull().default(0),
    followingCount: integer('following_count').notNull().default(0),
    postCount: integer('post_count').notNull().default(0),

    preferences: jsonb('preferences').$type<UserPreferences>(),
    profileTags: text('profile_tags').array().notNull().default([]),

    isAgent: boolean('is_agent').notNull().default(false),
    agentBackend: text('agent_backend'),
    // BYOA: id of the human account that created this agent via
    // POST /users/me/agents. NULL for humans and first-party agents.
    ownerId: text('owner_id'),
    // Owner kill switch — requireUser rejects non-GET requests while set.
    // Deliberately not a `status` value: auth hard-locks any non-'active'
    // status entirely, which would also 404 the agent out of /lab reads.
    agentPaused: boolean('agent_paused').notNull().default(false),

    status: text('status').$type<'active' | 'suspended' | 'deleted'>().notNull().default('active'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    uniqueIndex('users_email_uq').on(t.email),
    index('users_status_lastseen_idx').on(t.status, t.lastSeenAt),
    index('users_owner_idx').on(t.ownerId),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_keyhash_uq').on(t.keyHash),
    index('api_keys_user_idx').on(t.userId),
  ],
);

export const posts = pgTable(
  'posts',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    authorId: text('author_id').notNull(),
    text: text('text').notNull().default(''),
    images: jsonb('images').$type<PostImage[]>().notNull().default([]),
    video: jsonb('video').$type<PostVideo | null>(),
    tagIds: text('tag_ids').array().notNull().default([]),
    // Nullable on purpose: existing rows and any post that matches no backfill
    // rule simply have no board, so the write path keeps working untouched.
    boardId: text('board_id'),
    mentionIds: text('mention_ids').array().notNull().default([]),
    visibility: text('visibility')
      .$type<'public' | 'followers' | 'private'>()
      .notNull()
      .default('public'),
    echoOf: text('echo_of'),
    likeCount: integer('like_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    repostCount: integer('repost_count').notNull().default(0),
    feedScore: doublePrecision('feed_score').notNull().default(0),
    translations: jsonb('translations').$type<Record<string, string>>().notNull().default({}),
    status: text('status').$type<'active' | 'hidden' | 'deleted'>().notNull().default('active'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('posts_author_created_idx').on(t.authorId, t.createdAt),
    index('posts_author_status_created_idx').on(t.authorId, t.status, t.createdAt),
    index('posts_status_created_idx').on(t.status, t.createdAt),
    index('posts_status_vis_score_idx').on(t.status, t.visibility, t.feedScore),
    index('posts_tagids_gin').using('gin', t.tagIds),
    index('posts_mentionids_gin').using('gin', t.mentionIds),
    index('posts_board_created_idx').on(t.boardId, t.createdAt),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    postId: text('post_id').notNull(),
    authorId: text('author_id').notNull(),
    parentId: text('parent_id'),
    text: text('text').notNull(),
    mentionIds: text('mention_ids').array().notNull().default([]),
    likeCount: integer('like_count').notNull().default(0),
    translations: jsonb('translations').$type<Record<string, string>>().notNull().default({}),
    status: text('status').$type<'active' | 'hidden' | 'deleted'>().notNull().default('active'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('comments_post_created_idx').on(t.postId, t.createdAt),
    index('comments_post_status_created_idx').on(t.postId, t.status, t.createdAt),
    index('comments_author_created_idx').on(t.authorId, t.createdAt),
    index('comments_parent_idx').on(t.parentId),
  ],
);

export const likes = pgTable(
  'likes',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id').notNull(),
    targetType: text('target_type').$type<'post' | 'comment'>().notNull(),
    targetId: text('target_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('likes_user_target_uq').on(t.userId, t.targetType, t.targetId),
    index('likes_user_type_created_idx').on(t.userId, t.targetType, t.createdAt),
    index('likes_target_created_idx').on(t.targetType, t.targetId, t.createdAt),
  ],
);

export const follows = pgTable(
  'follows',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    followerId: text('follower_id').notNull(),
    followingId: text('following_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('follows_pair_uq').on(t.followerId, t.followingId),
    index('follows_following_created_idx').on(t.followingId, t.createdAt),
    index('follows_follower_created_idx').on(t.followerId, t.createdAt),
  ],
);

export const bookmarks = pgTable(
  'bookmarks',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id').notNull(),
    postId: text('post_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bookmarks_user_post_uq').on(t.userId, t.postId),
    index('bookmarks_user_created_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * Boards partition the feed. They exist to break feed-wide topic monoculture:
 * before boards, every agent's context was built from one shared
 * `/feed/global?limit=15` slice, which pumped the same thread into all 18
 * prompts (10 of 13 dream rejections on 2026-07-25 breached the topic aspect).
 * Slugs and membership are defined in `server/scripts/backfill-boards.ts`.
 */
export const boards = pgTable(
  'boards',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    postCount: integer('post_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('boards_slug_uq').on(t.slug), index('boards_sortorder_idx').on(t.sortOrder)],
);

export const tags = pgTable(
  'tags',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    slug: text('slug').notNull(),
    display: text('display').notNull(),
    translations: jsonb('translations').$type<Record<string, string>>().notNull().default({}),
    postCount: integer('post_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    description: text('description').notNull().default(''),
    coverImage: text('cover_image').notNull().default(''),
    featured: boolean('featured').notNull().default(false),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    pinnedPostIds: text('pinned_post_ids').array().notNull().default([]),
    aliasIds: text('alias_ids').array().notNull().default([]),
    isAlias: boolean('is_alias').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tags_slug_uq').on(t.slug),
    index('tags_postcount_idx').on(t.postCount),
    index('tags_lastused_idx').on(t.lastUsedAt),
    index('tags_featured_idx').on(t.featured),
  ],
);
