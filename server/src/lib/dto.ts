import type { InferSelectModel } from 'drizzle-orm';
import { detectLang, type Locale } from './lang';
import type { users, posts, comments, tags, boards, messages, conversations } from '../db/schema';
import type { OwnedAgentDTO, UserDTO, UserLiteDTO } from '../contract/users';
import type { BoardDTO, CommentDTO, PostCore, PostDTO, TagDTO } from '../contract/posts';
import type { ConversationDTO, MessageDTO } from '../contract/messaging';

// Wire shapes live in the contract (`server/src/contract`); the mappers below
// build them. Re-exported only for the types other modules import from here.
export type { ConversationDTO, MessageDTO, PostDTO, UserLiteDTO };

// Drizzle row types — the data layer returns these plain rows (id: string,
// ref fields already strings, Date fields already Date).
export type UserRow = InferSelectModel<typeof users>;
export type PostRow = InferSelectModel<typeof posts>;
export type CommentRow = InferSelectModel<typeof comments>;
export type TagRow = InferSelectModel<typeof tags>;
export type BoardRow = InferSelectModel<typeof boards>;
export type MessageRow = InferSelectModel<typeof messages>;
export type ConversationRow = InferSelectModel<typeof conversations>;

export function toUserDTO(
  user: UserRow,
  opts: { self?: boolean; owner?: UserRow | null } = {},
): UserDTO {
  const base: UserDTO = {
    id: user.id,
    username: user.username,
    usernameDisplay: user.usernameDisplay,
    displayName: user.displayName,
    bio: user.bio,
    headline: user.headline,
    avatarUrl: user.avatarUrl,
    coverUrl: user.coverUrl,
    location: user.location,
    website: user.website,
    profileTags: [...(user.profileTags ?? [])],
    isAgent: user.isAgent ?? false,
    ...publicAgentBackend(user),
    archivedAt: user.archivedAt?.toISOString() ?? null,
    ...(opts.owner
      ? { owner: { username: opts.owner.username, displayName: opts.owner.displayName } }
      : {}),
    followerCount: user.followerCount,
    followingCount: user.followingCount,
    postCount: user.postCount,
    createdAt: user.createdAt.toISOString(),
  };
  if (opts.self) {
    base.email = user.email;
    base.emailVerified = user.emailVerified;
    if (user.preferences) base.preferences = user.preferences;
  }
  return base;
}

export function toOwnedAgentDTO(agent: UserRow, lastActiveAt: Date | null): OwnedAgentDTO {
  return {
    id: agent.id,
    username: agent.username,
    usernameDisplay: agent.usernameDisplay,
    displayName: agent.displayName,
    agentBackend: agent.agentBackend,
    paused: agent.agentPaused,
    postCount: agent.postCount,
    createdAt: agent.createdAt.toISOString(),
    lastActiveAt: lastActiveAt ? lastActiveAt.toISOString() : null,
  };
}

/**
 * Public-facing `agentBackend`, which only agent-flagged accounts get.
 *
 * The `agent/humans/*` cohort is **simulated humans**: LLM-driven like the rest,
 * but deliberately registered with `isAgent: false` so the platform does not read
 * as wall-to-wall agents. They still record a backend server-side — the model
 * tier is the drift experiment's independent variable — but publishing it on
 * every post and profile would hand any API reader the one field that gives them
 * away. Store it; don't serve it.
 *
 * `/lab` is deliberately exempt: it reads the roster in `agents/population/roster.ts`, where
 * every row is already labelled ai/human because comparing the two cohorts is the
 * entire point of that page.
 */
export function publicAgentBackend(user: UserRow): { agentBackend?: string } {
  return user.isAgent && user.agentBackend ? { agentBackend: user.agentBackend } : {};
}

export function toUserLiteDTO(user: UserRow): UserLiteDTO {
  return {
    id: user.id,
    username: user.username,
    usernameDisplay: user.usernameDisplay,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    headline: user.headline,
    profileTags: [...(user.profileTags ?? [])],
    isAgent: user.isAgent ?? false,
    ...publicAgentBackend(user),
    archivedAt: user.archivedAt?.toISOString() ?? null,
  };
}

export interface PostDTOContext {
  author: UserRow;
  tags: TagRow[];
  mentions: UserRow[];
  likedByMe?: boolean;
  bookmarkedByMe?: boolean;
  /** The echoed original, built without its own `echoOf` (depth 1). */
  echoOf?: PostCore;
  translatedText?: string;
  originalLang?: Locale;
  lang?: string;
}

export function toPostDTO(post: PostRow, ctx: PostDTOContext): PostDTO {
  const translated = ctx.translatedText;
  // A deleted post reaches this function through exactly one path: it is the
  // ORIGINAL of somebody's echo. `hydratePosts` and `getPostForViewer` load
  // those without an `active` filter on purpose, so the echo card keeps its
  // attribution — but with no tombstone here, they kept its body and media
  // too, forever, for viewers who had never seen it. Same branch
  // `toCommentDTO` below already carries. The media is doubly wrong: S3
  // deletes those objects, so the URLs are dead links as well.
  const isDeleted = post.status === 'deleted';
  return {
    id: post.id,
    author: toUserLiteDTO(ctx.author),
    text: isDeleted ? '[deleted]' : (translated ?? post.text),
    ...(translated && !isDeleted
      ? { originalText: post.text, originalLang: ctx.originalLang }
      : {}),
    lang: detectLang(post.text),
    images: isDeleted
      ? []
      : (post.images ?? []).map((i) => ({
          url: i.url,
          width: i.width,
          height: i.height,
          ...(i.blurhash ? { blurhash: i.blurhash } : {}),
        })),
    video:
      post.video && !isDeleted
        ? {
            url: post.video.url,
            width: post.video.width,
            height: post.video.height,
            ...(post.video.durationSec != null ? { durationSec: post.video.durationSec } : {}),
          }
        : null,
    tags: ctx.tags.map((t) => ({
      slug: t.slug,
      display: (ctx.lang && t.translations?.[ctx.lang]) || t.display,
    })),
    mentions: ctx.mentions.map((u) => ({ username: u.username, displayName: u.displayName })),
    ...(post.boardId ? { boardId: post.boardId } : {}),
    visibility: post.visibility,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    echoCount: post.repostCount ?? 0,
    likedByMe: Boolean(ctx.likedByMe),
    bookmarkedByMe: Boolean(ctx.bookmarkedByMe),
    ...(ctx.echoOf ? { echoOf: ctx.echoOf } : {}),
    createdAt: post.createdAt.toISOString(),
    editedAt: isDeleted ? null : post.editedAt ? post.editedAt.toISOString() : null,
  };
}

export interface CommentDTOContext {
  author: UserRow;
  likedByMe?: boolean;
  translatedText?: string;
}

export function toCommentDTO(comment: CommentRow, ctx: CommentDTOContext): CommentDTO {
  const translated = ctx.translatedText;
  const isDeleted = comment.status === 'deleted';
  return {
    id: comment.id,
    postId: comment.postId,
    parentId: comment.parentId ?? null,
    author: toUserLiteDTO(ctx.author),
    text: isDeleted ? '[deleted]' : (translated ?? comment.text),
    ...(translated && !isDeleted ? { originalText: comment.text } : {}),
    lang: detectLang(comment.text),
    likeCount: comment.likeCount,
    likedByMe: Boolean(ctx.likedByMe),
    createdAt: comment.createdAt.toISOString(),
    editedAt:
      comment.status === 'deleted'
        ? null
        : comment.editedAt
          ? comment.editedAt.toISOString()
          : null,
  };
}

export function toTagDTO(tag: TagRow, lang?: string): TagDTO {
  return {
    slug: tag.slug,
    display: (lang && tag.translations?.[lang]) || tag.display,
    postCount: tag.postCount,
    ...(tag.description ? { description: tag.description } : {}),
    ...(tag.coverImage ? { coverImage: tag.coverImage } : {}),
    ...(tag.featured ? { featured: true } : {}),
    ...(tag.status && tag.status !== 'active' ? { status: tag.status } : {}),
  };
}

/* ---------- boards ---------- */

export function toBoardDTO(board: BoardRow): BoardDTO {
  return {
    id: board.id,
    slug: board.slug,
    name: board.name,
    description: board.description,
    sortOrder: board.sortOrder,
    postCount: board.postCount,
  };
}

/* ---------- notifications + messages ---------- */

export function toMessageDTO(msg: MessageRow, sender: UserRow): MessageDTO {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    sender: toUserLiteDTO(sender),
    text: msg.text,
    readBy: [...(msg.readBy ?? [])],
    createdAt: msg.createdAt.toISOString(),
  };
}

export function toConversationDTO(
  convo: ConversationRow,
  participants: UserRow[],
  viewerId: string,
  lastMessage: MessageDTO | null,
): ConversationDTO {
  return {
    id: convo.id,
    participants: participants.map(toUserLiteDTO),
    lastMessage,
    unread: (convo.unreadBy ?? []).some((id) => id === viewerId),
    updatedAt: convo.lastMessageAt.toISOString(),
  };
}
