import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Router } from 'express';
import { eq } from 'drizzle-orm';
import { resetDb } from '../../test/db-reset';
import { db } from '../../db/client';
import { tags, users } from '../../db/schema';
import { newId } from '../../lib/id';
import type { UserRow } from '../../lib/dto';
import { tagsRouter } from './tags.routes';

let seq = 0;
async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `user${seq}`,
      usernameDisplay: `user${seq}`,
      email: `user${seq}@example.com`,
      displayName: `User ${seq}`,
      ...over,
    })
    .returning();
  return u;
}

type TestRes = {
  statusCode: number;
  payload: unknown;
  ended: boolean;
  headers: Record<string, string | string[] | number>;
};

async function runRoute(
  router: Router,
  path: string,
  method: 'get' | 'patch',
  reqOverrides: Record<string, unknown> = {},
) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);

  const req = {
    body: {},
    params: {},
    query: {},
    headers: {},
    method: method.toUpperCase(),
    ip: '127.0.0.1',
    originalUrl: path,
    ...reqOverrides,
  };

  let resolvePromise: (() => void) | null = null;
  const done = () => {
    if (!resolvePromise) return;
    const resolve = resolvePromise;
    resolvePromise = null;
    resolve();
  };

  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    ended: false,
    headers: {} as Record<string, string | string[] | number>,
    req: { id: 'req-1' },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      this.ended = true;
      done();
      return this;
    },
    end() {
      this.ended = true;
      done();
      return this;
    },
    setHeader(name: string, value: string | string[] | number) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name: string) {
      return this.headers[name.toLowerCase()];
    },
    append(name: string, value: string | string[] | number) {
      this.setHeader(name, value);
      return this;
    },
  };

  let error: unknown;
  let idx = 0;
  await new Promise<void>((resolve) => {
    resolvePromise = resolve;
    const next = (err?: unknown) => {
      if (err) {
        error = err;
        done();
        return;
      }
      const handle = layer.route.stack[idx++]?.handle;
      if (!handle) {
        done();
        return;
      }
      try {
        const out = handle(req, res, next);
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          (out as Promise<unknown>)
            .then(() => {
              if (res.ended) done();
            })
            .catch(next);
        } else if (res.ended) {
          done();
        }
      } catch (caught) {
        next(caught);
      }
    };
    next();
  });

  return { req, res: res as TestRes, error };
}

describe('tags routes', () => {
  beforeEach(resetDb);
  afterEach(() => {
    delete process.env.ADMIN_USERNAME;
  });

  it('lists trending tags ordered by post count', async () => {
    await db.insert(tags).values([
      { slug: 'typescript', display: 'TypeScript', postCount: 10 },
      { slug: 'rust', display: 'Rust', postCount: 5 },
    ]);

    const { res, error } = await runRoute(tagsRouter, '/trending', 'get', {
      query: { limit: '5' },
    });

    expect(error).toBeUndefined();
    expect(res.payload).toEqual({
      data: {
        items: [
          { slug: 'typescript', display: 'TypeScript', postCount: 10 },
          { slug: 'rust', display: 'Rust', postCount: 5 },
        ],
      },
      meta: { requestId: 'req-1' },
    });
  });

  it('applies the default trending limit of 10 when none is provided', async () => {
    await db.insert(tags).values(
      Array.from({ length: 11 }, (_, i) => ({
        slug: `tag-${i}`,
        display: `Tag ${i}`,
        postCount: 100 - i,
      })),
    );

    const { res, error } = await runRoute(tagsRouter, '/trending', 'get');

    expect(error).toBeUndefined();
    const payload = res.payload as { data: { items: unknown[] } };
    expect(payload.data.items).toHaveLength(10);
  });

  it('excludes alias tags from trending', async () => {
    await db.insert(tags).values([
      { slug: 'typescript', display: 'TypeScript', postCount: 10 },
      { slug: 'ts', display: 'TS', postCount: 99, isAlias: true },
    ]);

    const { res, error } = await runRoute(tagsRouter, '/trending', 'get');

    expect(error).toBeUndefined();
    const payload = res.payload as { data: { items: Array<{ slug: string }> } };
    expect(payload.data.items.map((t) => t.slug)).toEqual(['typescript']);
  });

  it('looks up tags by lower-cased slug', async () => {
    await db.insert(tags).values({ slug: 'typescript', display: 'TypeScript', postCount: 42 });

    const { res, error } = await runRoute(tagsRouter, '/:slug', 'get', {
      params: { slug: 'TypeScript' },
    });

    expect(error).toBeUndefined();
    expect(res.payload).toEqual({
      data: {
        tag: { slug: 'typescript', display: 'TypeScript', postCount: 42 },
      },
      meta: { requestId: 'req-1' },
    });
  });

  it('returns not found when a tag does not exist', async () => {
    const { error } = await runRoute(tagsRouter, '/:slug', 'get', {
      params: { slug: 'missing' },
    });

    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  // ── GET /search ───────────────────────────────────────────────────────────

  it('searches tags by slug prefix, excluding aliases and zero-count tags', async () => {
    await db.insert(tags).values([
      { slug: 'typescript', display: 'TypeScript', postCount: 10 },
      { slug: 'typeorm', display: 'TypeORM', postCount: 3 },
      { slug: 'rust', display: 'Rust', postCount: 5 },
      { slug: 'typealias', display: 'TypeAlias', postCount: 8, isAlias: true },
      { slug: 'typezero', display: 'TypeZero', postCount: 0 },
    ]);

    const { res, error } = await runRoute(tagsRouter, '/search', 'get', {
      query: { q: 'type' },
    });

    expect(error).toBeUndefined();
    const payload = res.payload as { data: { items: Array<{ slug: string }> } };
    expect(payload.data.items.map((t) => t.slug)).toEqual(['typescript', 'typeorm']);
  });

  it('returns an empty list when no tag matches the search prefix', async () => {
    await db.insert(tags).values({ slug: 'rust', display: 'Rust', postCount: 5 });

    const { res, error } = await runRoute(tagsRouter, '/search', 'get', {
      query: { q: 'zzz' },
    });

    expect(error).toBeUndefined();
    const payload = res.payload as { data: { items: unknown[] } };
    expect(payload.data.items).toEqual([]);
  });

  it('applies an explicit search limit', async () => {
    await db.insert(tags).values([
      { slug: 'alpha', display: 'Alpha', postCount: 3 },
      { slug: 'alto', display: 'Alto', postCount: 2 },
      { slug: 'alps', display: 'Alps', postCount: 1 },
    ]);

    const { res, error } = await runRoute(tagsRouter, '/search', 'get', {
      query: { q: 'al', limit: '2' },
    });

    expect(error).toBeUndefined();
    const payload = res.payload as { data: { items: unknown[] } };
    expect(payload.data.items).toHaveLength(2);
  });

  it('rejects a search limit above the maximum', async () => {
    const { error } = await runRoute(tagsRouter, '/search', 'get', {
      query: { q: 'a', limit: '999' },
    });
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // ── PATCH /:slug (admin only) ─────────────────────────────────────────────

  it('lets an admin update a tag: pin posts, set aliases, and feature it', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    const admin = await seedUser({ username: 'admin', usernameDisplay: 'admin' });
    const [tag] = await db
      .insert(tags)
      .values({ slug: 'ai', display: 'AI', postCount: 5 })
      .returning();
    const [alias] = await db
      .insert(tags)
      .values({ slug: 'ml', display: 'ML', postCount: 2 })
      .returning();
    const pinned = [newId(), newId()];

    const { res, error } = await runRoute(tagsRouter, '/:slug', 'patch', {
      params: { slug: 'AI' },
      body: {
        featured: true,
        status: 'archived',
        pinnedPostIds: pinned,
        aliasSlugs: ['ml'],
        description: 'Artificial Intelligence',
      },
      session: { userId: admin.id },
    });

    expect(error).toBeUndefined();
    const payload = res.payload as { data: { tag: { featured?: boolean; status?: string } } };
    expect(payload.data.tag.featured).toBe(true);
    expect(payload.data.tag.status).toBe('archived');

    const [updated] = await db.select().from(tags).where(eq(tags.id, tag.id));
    expect(updated.pinnedPostIds).toEqual(pinned);
    expect(updated.aliasIds).toEqual([alias.id]);
    expect(updated.description).toBe('Artificial Intelligence');

    const [aliasRow] = await db.select().from(tags).where(eq(tags.id, alias.id));
    expect(aliasRow.isAlias).toBe(true);
  });

  it('handles aliasSlugs that match no existing tags', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    const admin = await seedUser({ username: 'admin', usernameDisplay: 'admin' });
    const [tag] = await db
      .insert(tags)
      .values({ slug: 'ai', display: 'AI', postCount: 5 })
      .returning();

    const { error } = await runRoute(tagsRouter, '/:slug', 'patch', {
      params: { slug: 'ai' },
      body: { aliasSlugs: ['doesnotexist'] },
      session: { userId: admin.id },
    });

    expect(error).toBeUndefined();
    const [updated] = await db.select().from(tags).where(eq(tags.id, tag.id));
    expect(updated.aliasIds).toEqual([]);
  });

  it('returns the tag unchanged when the patch body is empty', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    const admin = await seedUser({ username: 'admin', usernameDisplay: 'admin' });
    await db.insert(tags).values({ slug: 'ai', display: 'AI', postCount: 5 });

    const { res, error } = await runRoute(tagsRouter, '/:slug', 'patch', {
      params: { slug: 'ai' },
      body: {},
      session: { userId: admin.id },
    });

    expect(error).toBeUndefined();
    const payload = res.payload as { data: { tag: { slug: string } } };
    expect(payload.data.tag.slug).toBe('ai');
  });

  it('forbids a non-admin from patching a tag', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    const user = await seedUser({ username: 'bob', usernameDisplay: 'bob' });
    await db.insert(tags).values({ slug: 'ai', display: 'AI', postCount: 5 });

    const { error } = await runRoute(tagsRouter, '/:slug', 'patch', {
      params: { slug: 'ai' },
      body: { featured: true },
      session: { userId: user.id },
    });

    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('returns not found when patching a missing tag', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    const admin = await seedUser({ username: 'admin', usernameDisplay: 'admin' });

    const { error } = await runRoute(tagsRouter, '/:slug', 'patch', {
      params: { slug: 'ghost' },
      body: { featured: true },
      session: { userId: admin.id },
    });

    expect(error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('requires authentication to patch a tag', async () => {
    const { error } = await runRoute(tagsRouter, '/:slug', 'patch', {
      params: { slug: 'ai' },
      body: { featured: true },
    });

    expect(error).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });
});
