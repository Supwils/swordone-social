import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as s3 from '../../config/s3';
import { db } from '../../db/client';
import { users } from '../../db/schema';
import type { UserRow } from '../../lib/dto';
import { toUserDTO } from '../../lib/dto';
import { newId } from '../../lib/id';
import { resetDb } from '../../test/db-reset';
import { findById, searchUsers, updateAvatar, updateMe } from './users.service';

async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  const [u] = await db
    .insert(users)
    .values({
      username: 'ada',
      usernameDisplay: 'ada',
      email: 'ada@example.com',
      displayName: 'Ada',
      preferences: {
        theme: 'system',
        language: 'en',
        emailNotifications: true,
        pushNotifications: true,
      },
      ...over,
    })
    .returning();
  return u;
}

describe('users.service', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges preferences and normalizes profile tags on update', async () => {
    const user = await seedUser();

    const updated = await updateMe(user, {
      displayName: 'Ada Lovelace',
      preferences: { language: 'zh' },
      profileTags: [' AI ', 'Builder'],
    });

    expect(updated.displayName).toBe('Ada Lovelace');
    expect(updated.preferences).toMatchObject({
      theme: 'system',
      language: 'zh',
      emailNotifications: true,
      pushNotifications: true,
    });
    expect(updated.profileTags).toEqual(['ai', 'builder']);

    // The change is persisted, not just returned.
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.displayName).toBe('Ada Lovelace');
    expect(row.preferences?.language).toBe('zh');
    expect(row.profileTags).toEqual(['ai', 'builder']);
  });

  it('uploads a new avatar and deletes the old one after save', async () => {
    const user = await seedUser({ avatarUrl: 'https://cdn.example.com/old-avatar.webp' });

    vi.spyOn(s3, 'uploadBufferToS3').mockResolvedValue({
      url: 'https://cdn.example.com/new-avatar.webp',
      width: 256,
      height: 256,
    });
    const remove = vi.spyOn(s3, 'deleteFromS3').mockResolvedValue(undefined);

    const updated = await updateAvatar(user, Buffer.from('avatar'));

    expect(updated.avatarUrl).toBe('https://cdn.example.com/new-avatar.webp');
    expect(remove).toHaveBeenCalledWith('https://cdn.example.com/old-avatar.webp');

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.avatarUrl).toBe('https://cdn.example.com/new-avatar.webp');
  });

  it('allows agentBackend updates from non-agent accounts', async () => {
    // The agent/humans/ cohort is LLM-driven but runs with isAgent:false, so it
    // must still be able to record its model tier. isAgent stays untouched —
    // recording a backend does not promote an account to an agent.
    const user = await seedUser({ isAgent: false });

    const updated = await updateMe(user, { agentBackend: 'claude:haiku' });

    expect(updated.agentBackend).toBe('claude:haiku');
    expect(updated.isAgent).toBe(false);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.agentBackend).toBe('claude:haiku');
  });

  it('allows agentBackend updates for agent accounts', async () => {
    const user = await seedUser({ isAgent: true });

    const updated = await updateMe(user, { agentBackend: 'claude' });

    expect(updated.agentBackend).toBe('claude');

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.agentBackend).toBe('claude');
  });

  it('findById returns active users and null for missing or inactive ones', async () => {
    const user = await seedUser();
    const suspended = await seedUser({
      username: 'grace',
      usernameDisplay: 'grace',
      email: 'grace@example.com',
      status: 'suspended',
    });

    expect((await findById(user.id))?.id).toBe(user.id);
    expect(await findById(newId())).toBeNull();
    expect(await findById(suspended.id)).toBeNull();
  });

  it('searchUsers browse (no query) leaves out archived accounts; a name search finds them', async () => {
    const live = await seedUser({ followerCount: 1 });
    const archived = await seedUser({
      username: 'adaold',
      usernameDisplay: 'adaold',
      email: 'adaold@example.com',
      followerCount: 9,
      profileTags: ['ai'],
      archivedAt: new Date('2026-10-14T00:00:00Z'),
    });

    expect((await searchUsers(undefined, undefined, 10)).map((u) => u.id)).toEqual([live.id]);
    expect((await searchUsers('', undefined, 10)).map((u) => u.id)).toEqual([live.id]);
    expect(await searchUsers(undefined, 'ai', 10)).toEqual([]);
    expect((await searchUsers('ada', undefined, 10)).map((u) => u.id)).toEqual([
      archived.id,
      live.id,
    ]);
  });

  it('toUserDTO exposes the owner only when provided', async () => {
    const owner = await seedUser();
    const agent = await seedUser({
      username: 'ownedbot',
      usernameDisplay: 'ownedbot',
      email: 'ownedbot@agents.swil',
      isAgent: true,
      ownerId: owner.id,
    });

    const withOwner = toUserDTO(agent, { owner });
    expect(withOwner.owner).toEqual({ username: owner.username, displayName: owner.displayName });

    const withoutOwner = toUserDTO(agent, {});
    expect(withoutOwner.owner).toBeUndefined();
  });
});
