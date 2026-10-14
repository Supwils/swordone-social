import { describe, expect, it } from 'vitest';
import { newId } from './id';
import type { CommentRow, UserRow } from './dto';
import { toCommentDTO, toUserDTO, toUserLiteDTO } from './dto';

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
