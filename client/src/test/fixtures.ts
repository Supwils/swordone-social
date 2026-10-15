/**
 * Shared DTO factories for tests, typed against the API contract.
 *
 * Every default satisfies the contract's required fields (`archivedAt: null`,
 * `lang: 'en'`, …), so a test only spells out what it is about. Pass a
 * Partial to override; nested objects (an author, an echo original) are
 * built with the factory for that shape.
 *
 * Build DTOs here instead of casting a literal (`as unknown as PostDTO`): a
 * cast hides a field the server made required, a factory does not.
 */
import type {
  AgentSummaryDTO,
  AgentSummaryItem,
  CommentDTO,
  ConversationDTO,
  ExploreSummaryDTO,
  FeaturedTopicDTO,
  MessageDTO,
  NotificationDTO,
  PostDTO,
  TagDTO,
  UserDTO,
  UserLiteDTO,
} from '@/contract';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

/** The author card on posts, comments, messages and notifications. A live human by default. */
export function makeUserLite(over: Partial<UserLiteDTO> = {}): UserLiteDTO {
  return {
    id: 'u-1',
    username: 'alice',
    usernameDisplay: 'alice',
    displayName: 'Alice',
    avatarUrl: null,
    headline: '',
    profileTags: [],
    isAgent: false,
    archivedAt: null,
    ...over,
  };
}

/** A full profile (no self-only fields unless overridden). */
export function makeUser(over: Partial<UserDTO> = {}): UserDTO {
  return {
    ...makeUserLite(),
    bio: '',
    coverUrl: null,
    location: null,
    website: null,
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
    createdAt: CREATED_AT,
    ...over,
  };
}

/** A public, unliked post in English with no media. */
export function makePost(over: Partial<PostDTO> = {}): PostDTO {
  return {
    id: 'p-1',
    author: makeUserLite(),
    text: 'hello world',
    lang: 'en',
    images: [],
    video: null,
    tags: [],
    mentions: [],
    visibility: 'public',
    likeCount: 0,
    commentCount: 0,
    echoCount: 0,
    likedByMe: false,
    bookmarkedByMe: false,
    createdAt: CREATED_AT,
    editedAt: null,
    ...over,
  };
}

/** A top-level comment in English. */
export function makeComment(over: Partial<CommentDTO> = {}): CommentDTO {
  return {
    id: 'c-1',
    postId: 'p-1',
    parentId: null,
    author: makeUserLite(),
    text: 'nice post',
    lang: 'en',
    likeCount: 0,
    likedByMe: false,
    createdAt: CREATED_AT,
    editedAt: null,
    ...over,
  };
}

/** An active, non-featured tag. */
export function makeTag(over: Partial<TagDTO> = {}): TagDTO {
  return {
    slug: 'garden',
    display: 'garden',
    postCount: 0,
    ...over,
  };
}

/** A featured tag with no pinned posts. */
export function makeFeaturedTopic(over: Partial<FeaturedTopicDTO> = {}): FeaturedTopicDTO {
  return {
    ...makeTag(),
    featured: true,
    pinnedPosts: [],
    ...over,
  };
}

/** One agent card on /explore. */
export function makeAgentSummaryItem(over: Partial<AgentSummaryItem> = {}): AgentSummaryItem {
  return {
    id: 'u-agent',
    username: 'agent',
    usernameDisplay: 'agent',
    displayName: 'Agent',
    avatarUrl: null,
    headline: '',
    latestPostExcerpt: null,
    latestPostId: null,
    ...over,
  };
}

/** An empty /feed/explore-summary body. */
export function makeExploreSummary(over: Partial<ExploreSummaryDTO> = {}): ExploreSummaryDTO {
  return {
    featuredPost: null,
    agents: [],
    trendingTags: [],
    featuredTopics: [],
    ...over,
  };
}

/** An unread like notification with no post / comment / message reference. */
export function makeNotification(over: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: 'n-1',
    type: 'like',
    actor: makeUserLite(),
    read: false,
    createdAt: CREATED_AT,
    ...over,
  };
}

/** A direct message nobody has read yet. */
export function makeMessage(over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    sender: makeUserLite(),
    text: 'hi',
    readBy: [],
    createdAt: CREATED_AT,
    ...over,
  };
}

/** A conversation with no messages yet. */
export function makeConversation(over: Partial<ConversationDTO> = {}): ConversationDTO {
  return {
    id: 'c-1',
    participants: [makeUserLite()],
    lastMessage: null,
    unread: false,
    updatedAt: CREATED_AT,
    ...over,
  };
}

/** One lab roster row (`GET /agents`): a live, unmeasured Era 3 agent outside any arm. */
export function makeLabAgent(over: Partial<AgentSummaryDTO> = {}): AgentSummaryDTO {
  return {
    id: 'u-agent',
    username: 'agent',
    displayName: 'Agent',
    headline: '',
    avatarUrl: null,
    isAgent: true,
    archivedAt: null,
    arm: null,
    cohort: 'first-party',
    followerCount: 0,
    postCount: 0,
    lastSnapshotAt: null,
    currentDriftFromAnchor: null,
    driftSparkline: [],
    postsLast7d: 0,
    currentFidelity: null,
    ...over,
  };
}
