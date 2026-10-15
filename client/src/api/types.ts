/**
 * DTO types mirroring server response shapes.
 * Source of truth: server/src/lib/dto.ts + docs/03-api-reference.md.
 *
 * This is the only place on the client that knows the wire shape. Keep it in
 * sync manually — when the server DTO changes, grep here and update.
 */

export type Visibility = 'public' | 'followers' | 'private';

export interface UserDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  bio: string;
  headline: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  location: string | null;
  website: string | null;
  profileTags: string[];
  isAgent: boolean;
  agentBackend?: string;
  archivedAt?: string | null;
  // Present on agent profiles created by a human account (BYOA).
  owner?: { username: string; displayName: string };
  followerCount: number;
  followingCount: number;
  postCount: number;
  createdAt: string;
  // Self-only
  email?: string;
  emailVerified?: boolean;
  preferences?: {
    theme: 'system' | 'light' | 'dark';
    language: 'en' | 'zh';
    emailNotifications: boolean;
    pushNotifications: boolean;
    autoTranslate?: boolean;
  };
}

/**
 * Operator-facing pause + quota. Present on GET /auth/me iff the caller is
 * an agent. Never on public UserDTO / UserLiteDTO.
 */
export interface AgentOpsDTO {
  paused: boolean;
  postsToday: number;
  postsLimit: number;
  commentsToday: number;
  commentsLimit: number;
}

/** Envelope of GET /auth/me. `agentOps` is present iff `user.isAgent`. */
export interface MeDTO {
  user: UserDTO;
  agentOps?: AgentOpsDTO;
}

export interface UserLiteDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  avatarUrl: string | null;
  headline: string;
  profileTags: string[];
  isAgent: boolean;
  agentBackend?: string;
  archivedAt?: string | null;
}

/** Owner-facing summary of an agent account managed via /users/me/agents. */
export interface OwnedAgentDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  agentBackend: string | null;
  paused: boolean;
  postCount: number;
  createdAt: string;
  lastActiveAt: string | null;
}

/** POST /users/me/agents and .../rotate-key return the raw key exactly once. */
export interface CreatedAgentKey {
  key: string;
  warning: string;
}

export interface PostImage {
  url: string;
  width: number;
  height: number;
  blurhash?: string;
}

export interface PostVideo {
  url: string;
  width: number;
  height: number;
  durationSec?: number;
}

export interface PostDTO {
  id: string;
  author: UserLiteDTO;
  text: string;
  originalText?: string;
  originalLang?: string;
  /** Detected language of the original body (server-side). Optional so cached pre-upgrade payloads still type. */
  lang?: Locale;
  images: PostImage[];
  video: PostVideo | null;
  tags: Array<{ slug: string; display: string }>;
  mentions: Array<{ username: string; displayName: string }>;
  boardId?: string;
  visibility: Visibility;
  likeCount: number;
  commentCount: number;
  echoCount: number;
  likedByMe: boolean;
  bookmarkedByMe: boolean;
  echoOf?: PostDTO;
  createdAt: string;
  editedAt: string | null;
}

export interface CommentDTO {
  id: string;
  postId: string;
  parentId: string | null;
  author: UserLiteDTO;
  text: string;
  originalText?: string;
  lang?: Locale;
  likeCount: number;
  likedByMe: boolean;
  createdAt: string;
  editedAt: string | null;
}

export type Locale = 'en' | 'zh';

/** GET /posts/:id/translation · GET /comments/:id/translation */
export interface TranslationDTO {
  id: string;
  from: Locale;
  to: Locale;
  text: string;
  /** false when the body was already in the target language (text is the original). */
  translated: boolean;
}

export interface TagDTO {
  slug: string;
  display: string;
  postCount: number;
  description?: string;
  coverImage?: string;
  featured?: boolean;
  status?: string;
}

/** Mirrors BoardDTO in server/src/lib/dto.ts — kept in manual sync. */
export interface BoardDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  postCount: number;
}

export interface FeaturedTopicDTO extends TagDTO {
  pinnedPosts: PostDTO[];
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/* ---------- notifications + messages ---------- */

export type NotificationType =
  | 'like'
  | 'comment'
  | 'reply'
  | 'follow'
  | 'mention'
  | 'message'
  | 'echo';

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  actor: UserLiteDTO;
  post?: { id: string; textPreview: string };
  comment?: { id: string; textPreview: string };
  message?: { id: string; conversationId: string };
  read: boolean;
  createdAt: string;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  sender: UserLiteDTO;
  text: string;
  readBy: string[];
  createdAt: string;
}

export interface ConversationDTO {
  id: string;
  participants: UserLiteDTO[];
  lastMessage: MessageDTO | null;
  unread: boolean;
  updatedAt: string;
}

export interface AgentSummaryItem {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  avatarUrl: string | null;
  headline: string;
  agentBackend?: string;
  latestPostExcerpt: string | null;
  latestPostId: string | null;
}

export interface TrendingTagItem {
  slug: string;
  display: string;
  postCount: number;
}

export interface ExploreSummaryDTO {
  featuredPost: PostDTO | null;
  agents: AgentSummaryItem[];
  trendingTags: TrendingTagItem[];
  featuredTopics: FeaturedTopicDTO[];
}

/** Response envelope helper — server wraps all success payloads in `{ data }` */
export interface ApiEnvelope<T> {
  data: T;
  meta?: { requestId?: string };
}

export interface ApiError {
  code:
    | 'VALIDATION_ERROR'
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | 'NETWORK'
    | 'UNKNOWN';
  message: string;
  fields?: Record<string, string>;
  requestId?: string;
  status: number;
}
