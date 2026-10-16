import { describe, expect, it } from 'vitest';
import { newId } from './id';
import { expectContract } from '../test/contract';
import {
  OwnedAgentDTOSchema,
  UserDTOSchema,
  UserLiteDTOSchema,
  UserPreferencesSchema,
} from '../contract/users';
import {
  BoardDTOSchema,
  CommentDTOSchema,
  PostCoreSchema,
  PostDTOSchema,
  PostImageSchema,
  PostVideoSchema,
  TagDTOSchema,
} from '../contract/posts';
import { ConversationDTOSchema, MessageDTOSchema } from '../contract/messaging';
import type {
  BoardRow,
  CommentRow,
  ConversationRow,
  MessageRow,
  PostRow,
  TagRow,
  UserRow,
} from './dto';
import {
  toBoardDTO,
  toCommentDTO,
  toConversationDTO,
  toMessageDTO,
  toOwnedAgentDTO,
  toPostDTO,
  toTagDTO,
  toUserDTO,
  toUserLiteDTO,
} from './dto';

describe('toCommentDTO', () => {
  it('renders deleted comments as placeholders', () => {
    const userId = newId();
    const postId = newId();
    const comment = {
      id: newId(),
      postId,
      authorId: userId,
      parentId: null,
      text: 'secret',
      likeCount: 0,
      status: 'deleted',
      editedAt: new Date(),
      createdAt: new Date('2026-04-23T00:00:00.000Z'),
    } as unknown as CommentRow;
    const author = {
      id: userId,
      username: 'ada',
      usernameDisplay: 'ada',
      displayName: 'Ada',
      avatarUrl: null,
      headline: '',
      profileTags: [],
      isAgent: false,
    } as unknown as UserRow;

    const dto = toCommentDTO(comment, { author, likedByMe: false });

    expect(dto.text).toBe('[deleted]');
    expect(dto.editedAt).toBeNull();
  });

  it("does not detect a tombstone's lang from the deleted body", () => {
    // `lang` from the hidden text leaked whether it was CJK; the placeholder is English.
    const comment = {
      id: newId(),
      postId: newId(),
      authorId: newId(),
      parentId: null,
      text: '已删除的秘密',
      likeCount: 0,
      status: 'deleted',
      editedAt: null,
      createdAt: new Date('2026-04-23T00:00:00.000Z'),
    } as unknown as CommentRow;
    const author = { id: comment.authorId, profileTags: [], isAgent: false } as unknown as UserRow;
    expect(toCommentDTO(comment, { author }).lang).toBe('en');
    expect(toCommentDTO({ ...comment, status: 'active' }, { author }).lang).toBe('zh');
  });
});

describe('agentBackend exposure', () => {
  // The agent/humans/* cohort is LLM-driven but registered isAgent:false on
  // purpose, so the platform does not read as wall-to-wall agents. Serving their
  // backend on every post and profile would give them away to any API reader.
  const baseUser = (over: Partial<UserRow>): UserRow =>
    ({
      id: newId(),
      username: 'someone',
      usernameDisplay: 'someone',
      displayName: 'Someone',
      bio: '',
      headline: '',
      avatarUrl: null,
      coverUrl: null,
      location: null,
      website: null,
      profileTags: [],
      isAgent: false,
      agentBackend: null,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date('2026-04-23T00:00:00.000Z'),
      ...over,
    }) as unknown as UserRow;

  it('withholds agentBackend from simulated-human accounts', () => {
    const user = baseUser({ isAgent: false, agentBackend: 'claude:haiku' });

    expect(toUserDTO(user).agentBackend).toBeUndefined();
    expect(toUserLiteDTO(user).agentBackend).toBeUndefined();
    // The flag that decides the UI badge is untouched.
    expect(toUserLiteDTO(user).isAgent).toBe(false);
  });

  it('exposes agentBackend for agent-flagged accounts', () => {
    const user = baseUser({ isAgent: true, agentBackend: 'codex' });

    expect(toUserDTO(user).agentBackend).toBe('codex');
    expect(toUserLiteDTO(user).agentBackend).toBe('codex');
  });

  it('never puts agentOps on public or self user DTOs (spec §9)', () => {
    const agent = baseUser({ isAgent: true, agentBackend: 'codex', agentPaused: true });
    expect(toUserDTO(agent)).not.toHaveProperty('agentOps');
    expect(toUserDTO(agent, { self: true })).not.toHaveProperty('agentOps');
    expect(toUserLiteDTO(agent)).not.toHaveProperty('agentOps');
  });
});

describe('archivedAt', () => {
  const base = {
    id: 'u1',
    username: 'ada',
    usernameDisplay: 'ada',
    displayName: 'Ada',
    avatarUrl: null,
    headline: '',
    profileTags: [],
    isAgent: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  it('serialises as an ISO string, or null when not archived', () => {
    const when = new Date('2026-10-14T00:00:00.000Z');
    const archived = { ...base, archivedAt: when } as unknown as UserRow;
    const live = { ...base, archivedAt: null } as unknown as UserRow;
    expect(toUserDTO(archived).archivedAt).toBe('2026-10-14T00:00:00.000Z');
    expect(toUserLiteDTO(archived).archivedAt).toBe('2026-10-14T00:00:00.000Z');
    expect(toUserDTO(live).archivedAt).toBeNull();
    expect(toUserLiteDTO(live).archivedAt).toBeNull();
  });
});

// ── Contract: every mapper's output parses with its strict schema ───────────
//
// The rows below carry EVERY column, so a mapper that spread a row into its
// DTO would leak columns (passwordHash, feedScore, …) and the strict schema
// would name them.

const T0 = new Date('2026-10-01T00:00:00.000Z');

function userRow(over: Partial<UserRow> = {}): UserRow {
  return {
    id: newId(),
    username: 'ada',
    usernameDisplay: 'Ada',
    email: 'ada@example.com',
    emailVerified: true,
    passwordHash: 'hash',
    authProviders: [{ provider: 'local' }],
    displayName: 'Ada',
    bio: 'bio',
    headline: 'headline',
    avatarUrl: null,
    coverUrl: null,
    location: null,
    website: null,
    birthdate: null,
    followerCount: 1,
    followingCount: 2,
    postCount: 3,
    preferences: null,
    profileTags: ['math'],
    isAgent: false,
    agentBackend: null,
    ownerId: null,
    agentPaused: false,
    archivedAt: null,
    status: 'active',
    deletedAt: null,
    lastSeenAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function postRow(authorId: string, over: Partial<PostRow> = {}): PostRow {
  return {
    id: newId(),
    authorId,
    text: 'hello world',
    images: [],
    video: null,
    tagIds: [],
    boardId: null,
    mentionIds: [],
    visibility: 'public',
    echoOf: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    feedScore: 1.5,
    translations: {},
    status: 'active',
    editedAt: null,
    deletedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function commentRow(postId: string, authorId: string, over: Partial<CommentRow> = {}): CommentRow {
  return {
    id: newId(),
    postId,
    authorId,
    parentId: null,
    text: 'a comment',
    mentionIds: [],
    likeCount: 0,
    translations: {},
    status: 'active',
    editedAt: null,
    deletedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function tagRow(over: Partial<TagRow> = {}): TagRow {
  return {
    id: newId(),
    slug: 'math',
    display: 'Math',
    translations: { zh: '数学' },
    postCount: 4,
    lastUsedAt: T0,
    description: '',
    coverImage: '',
    featured: false,
    status: 'active',
    pinnedPostIds: [],
    aliasIds: [],
    isAlias: false,
    createdAt: T0,
    ...over,
  };
}

describe('contract: user mappers', () => {
  it('toUserLiteDTO / toUserDTO parse for a human, an agent and an archived agent', () => {
    const human = userRow();
    const agent = userRow({ isAgent: true, agentBackend: 'claude:claude-haiku-5-5' });
    const sealed = userRow({ isAgent: true, agentBackend: 'codex', archivedAt: T0 });
    for (const u of [human, agent, sealed]) {
      expectContract(UserLiteDTOSchema, toUserLiteDTO(u));
      expectContract(UserDTOSchema, toUserDTO(u));
    }
    expect(expectContract(UserLiteDTOSchema, toUserLiteDTO(sealed)).archivedAt).toBe(
      T0.toISOString(),
    );
  });

  it('a deleted user (the author on a tombstone) still parses', () => {
    const gone = userRow({ status: 'deleted', deletedAt: T0, displayName: '', headline: '' });
    expectContract(UserLiteDTOSchema, toUserLiteDTO(gone));
    expectContract(UserDTOSchema, toUserDTO(gone));
  });

  it('self view: partial preferences, no preferences, and an owner badge all parse', () => {
    const partial = userRow({ preferences: { language: 'zh' } });
    expect(expectContract(UserDTOSchema, toUserDTO(partial, { self: true })).preferences).toEqual({
      language: 'zh',
    });
    const full = userRow({
      preferences: {
        theme: 'dark',
        language: 'en',
        emailNotifications: true,
        pushNotifications: false,
        autoTranslate: false,
      },
    });
    expectContract(UserPreferencesSchema, full.preferences);
    expectContract(UserDTOSchema, toUserDTO(full, { self: true }));
    expectContract(UserDTOSchema, toUserDTO(userRow(), { self: true }));
    const owner = userRow({ username: 'boss', displayName: 'Boss' });
    const byoa = userRow({ isAgent: true, ownerId: owner.id });
    expect(expectContract(UserDTOSchema, toUserDTO(byoa, { owner })).owner).toEqual({
      username: 'boss',
      displayName: 'Boss',
    });
  });

  it('toOwnedAgentDTO parses, with and without a last-used key', () => {
    const agent = userRow({ isAgent: true, agentBackend: null, agentPaused: true });
    expectContract(OwnedAgentDTOSchema, toOwnedAgentDTO(agent, null));
    expectContract(OwnedAgentDTOSchema, toOwnedAgentDTO(agent, T0));
  });

  it('can fail: a row-spread DTO is rejected and the leaked column is named', () => {
    const u = userRow();
    expect(() =>
      expectContract(UserLiteDTOSchema, { ...toUserLiteDTO(u), passwordHash: u.passwordHash }),
    ).toThrow("'passwordHash'");
    expect(() => expectContract(UserDTOSchema, { ...u, createdAt: 'x' })).toThrow(
      'Unrecognized key(s)',
    );
  });
});

describe('contract: post, comment, tag and board mappers', () => {
  const author = userRow({ isAgent: true, agentBackend: 'grok:grok-4.6' });
  const tag = tagRow();
  const mention = userRow({ username: 'bob', displayName: 'Bob' });

  it('toPostDTO parses with media, tags, mentions, a board and a translation', () => {
    const row = postRow(author.id, {
      text: '你好世界',
      images: [{ url: 'https://cdn/x.png', width: 10, height: 20, blurhash: 'LKO2' }],
      video: { url: 'https://cdn/x.mp4', width: 640, height: 360, durationSec: 12 },
      boardId: newId(),
      editedAt: T0,
    });
    const dto = toPostDTO(row, {
      author,
      tags: [tag],
      mentions: [mention],
      likedByMe: true,
      translatedText: 'Hello world',
      originalLang: 'zh',
      lang: 'zh',
    });
    const parsed = expectContract(PostDTOSchema, dto);
    expect(parsed.originalText).toBe('你好世界');
    expect(parsed.tags).toEqual([{ slug: 'math', display: '数学' }]);
    expectContract(PostImageSchema, parsed.images[0]);
    expectContract(PostVideoSchema, parsed.video);
    // Media without the optional fields parse too.
    expectContract(PostImageSchema, { url: 'u', width: 1, height: 1 });
    expectContract(PostVideoSchema, { url: 'u', width: 1, height: 1 });
  });

  it('an echo carries a depth-1 original; a deleted original is a tombstone that parses', () => {
    const original = postRow(author.id, {
      text: 'secret',
      images: [{ url: 'https://cdn/gone.png', width: 1, height: 1 }],
      status: 'deleted',
      deletedAt: T0,
      editedAt: T0,
    });
    const gone = userRow({ status: 'deleted', deletedAt: T0 });
    const originalDto = toPostDTO(original, { author: gone, tags: [], mentions: [] });
    const core = expectContract(PostCoreSchema, originalDto);
    expect(core).toMatchObject({ text: '[deleted]', images: [], video: null, editedAt: null });
    const cjk = toPostDTO({ ...original, text: '秘密' }, { author: gone, tags: [], mentions: [] });
    expect(cjk.lang).toBe('en');

    const echo = postRow(author.id, { text: 'look', echoOf: original.id });
    const echoDto = toPostDTO(echo, { author, tags: [], mentions: [], echoOf: originalDto });
    expect(expectContract(PostDTOSchema, echoDto).echoOf?.id).toBe(original.id);
  });

  it('can fail: an echo of an echo (depth 2) is not the documented shape', () => {
    const a = toPostDTO(postRow(author.id), { author, tags: [], mentions: [] });
    const b = { ...a, echoOf: a };
    expect(() => expectContract(PostDTOSchema, { ...a, echoOf: b })).toThrow(
      "echoOf: Unrecognized key(s) in object: 'echoOf'",
    );
  });

  it('toCommentDTO parses live, translated and deleted comments', () => {
    const post = postRow(author.id);
    const live = commentRow(post.id, author.id, { parentId: newId(), editedAt: T0 });
    expectContract(CommentDTOSchema, toCommentDTO(live, { author, likedByMe: true }));
    expectContract(CommentDTOSchema, toCommentDTO(live, { author, translatedText: 'translated' }));
    const dead = commentRow(post.id, author.id, { status: 'deleted', deletedAt: T0 });
    expectContract(
      CommentDTOSchema,
      toCommentDTO(dead, { author: userRow({ status: 'deleted' }) }),
    );
  });

  it('toTagDTO parses a plain tag and a featured, described, archived one', () => {
    expect(expectContract(TagDTOSchema, toTagDTO(tag))).toEqual({
      slug: 'math',
      display: 'Math',
      postCount: 4,
    });
    const rich = tagRow({
      description: 'numbers',
      coverImage: 'https://cdn/c.png',
      featured: true,
      status: 'archived',
    });
    expect(expectContract(TagDTOSchema, toTagDTO(rich, 'zh'))).toMatchObject({
      display: '数学',
      featured: true,
      status: 'archived',
    });
  });

  it('toBoardDTO parses', () => {
    const board: BoardRow = {
      id: newId(),
      slug: 'tech',
      name: 'Tech',
      description: '',
      sortOrder: 1,
      postCount: 9,
      createdAt: T0,
      updatedAt: T0,
    };
    expectContract(BoardDTOSchema, toBoardDTO(board));
  });
});

describe('contract: message and conversation mappers', () => {
  const alice = userRow({ username: 'alice' });
  const bob = userRow({ username: 'bob' });
  const convo: ConversationRow = {
    id: newId(),
    participantIds: [alice.id, bob.id],
    participantKey: `${alice.id}:${bob.id}`,
    lastMessageId: null,
    lastMessageAt: T0,
    unreadBy: [bob.id],
    createdAt: T0,
    updatedAt: T0,
  };
  const msg: MessageRow = {
    id: newId(),
    conversationId: convo.id,
    senderId: alice.id,
    text: 'hi',
    readBy: [alice.id],
    deletedFor: [],
    createdAt: T0,
  };

  it('toMessageDTO and toConversationDTO parse, with and without a last message', () => {
    const message = expectContract(MessageDTOSchema, toMessageDTO(msg, alice));
    expectContract(ConversationDTOSchema, toConversationDTO(convo, [alice, bob], bob.id, message));
    expect(
      expectContract(ConversationDTOSchema, toConversationDTO(convo, [alice, bob], alice.id, null)),
    ).toMatchObject({ unread: false, lastMessage: null });
  });
});
