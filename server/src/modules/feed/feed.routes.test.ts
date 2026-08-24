import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

const mocks = vi.hoisted(() => ({
  following: vi.fn(),
  global: vi.fn(),
  byTag: vi.fn(),
  byAuthor: vi.fn(),
  byBoard: vi.fn(),
  getExploreSummary: vi.fn(),
}));

vi.mock('../../middlewares/auth', () => ({
  requireUser: (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    req.user = { id: 'viewer-id' };
    next();
  },
  optionalUser: (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    next();
  },
}));

vi.mock('./feed.service', () => ({
  following: mocks.following,
  global: mocks.global,
  byTag: mocks.byTag,
  byAuthor: mocks.byAuthor,
  byBoard: mocks.byBoard,
  getExploreSummary: mocks.getExploreSummary,
}));

import { decodeCursor, decodeScoreCursor, encodeCursor } from '../../lib/pagination';
import { feedRouter, userPostsRouter } from './feed.routes';

const CURSOR_ID = 'a'.repeat(24); // both decoders reject an id that is not an ObjectId

/** There is no `encodeScoreCursor` in `lib/pagination`; this is `encodeCursor`'s
 *  body against the `{ s, id }` shape `decodeScoreCursor` accepts. */
function encodeScoreCursor(c: { s: number; id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

async function runRoute(
  router: Router,
  path: string,
  method: 'get',
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

  return { req, res, error };
}

describe('feed routes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns following feed for an authenticated viewer', async () => {
    mocks.following.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { res, error } = await runRoute(feedRouter, '/', 'get', {
      query: { limit: '12' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.following).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'viewer-id' }),
      null,
      12,
      'recommended',
    );
  });

  it('returns global feed for anonymous viewers', async () => {
    mocks.global.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { res, error } = await runRoute(feedRouter, '/global', 'get');

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.global).toHaveBeenCalledWith(null, null, 20, 'recommended');
  });

  it('passes tag slugs through to the tag feed', async () => {
    mocks.byTag.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { res, error } = await runRoute(feedRouter, '/tag/:slug', 'get', {
      params: { slug: 'typescript' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.byTag).toHaveBeenCalledWith('typescript', null, null, 20, 'recommended');
  });

  it('passes board slugs through with the default sort', async () => {
    mocks.byBoard.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { res, error } = await runRoute(feedRouter, '/board/:slug', 'get', {
      params: { slug: 'market' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.byBoard).toHaveBeenCalledWith('market', null, null, 20, 'recommended');
  });

  it('forwards sort=latest to the board feed instead of dropping it', async () => {
    // The regression: this route validated `sort` through the shared
    // `pagingQuery` and then never read `req.query.sort`, so every board read
    // was ranked whatever the caller asked for. Its `/global` sibling twenty
    // lines above had always read it.
    mocks.byBoard.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { error } = await runRoute(feedRouter, '/board/:slug', 'get', {
      params: { slug: 'market' },
      query: { sort: 'latest', limit: '18' },
    });

    expect(error).toBeUndefined();
    expect(mocks.byBoard).toHaveBeenCalledWith('market', null, null, 18, 'latest');
  });

  it('forwards sort=latest to the tag feed instead of dropping it', async () => {
    // The same defect fixed for `/board/:slug` on 2026-08-19, left standing on
    // its sibling: `pagingQuery` validates `sort` for every feed route, and
    // this handler hardcoded `decodeScoreCursor` and called a `byTag` with no
    // `sort` parameter. `?sort=latest` silently served the ranked feed.
    mocks.byTag.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { error } = await runRoute(feedRouter, '/tag/:slug', 'get', {
      params: { slug: 'garden' },
      query: { sort: 'latest', limit: '18' },
    });

    expect(error).toBeUndefined();
    expect(mocks.byTag).toHaveBeenCalledWith('garden', null, null, 18, 'latest');
  });

  it('decodes a TIME cursor for a latest tag page and a SCORE cursor otherwise', async () => {
    // `paginateByTime` and `paginateByScore` consume different cursor shapes;
    // a decoder that does not follow the sort pages from the wrong key.
    mocks.byTag.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });
    const timeCursor = encodeCursor({ t: '2026-08-20T08:00:00.000Z', id: CURSOR_ID });
    const scoreCursor = encodeScoreCursor({ s: 42, id: CURSOR_ID });

    await runRoute(feedRouter, '/tag/:slug', 'get', {
      params: { slug: 'garden' },
      query: { sort: 'latest', cursor: timeCursor },
    });
    expect(mocks.byTag).toHaveBeenCalledWith(
      'garden',
      null,
      decodeCursor(timeCursor),
      20,
      'latest',
    );

    mocks.byTag.mockClear();
    await runRoute(feedRouter, '/tag/:slug', 'get', {
      params: { slug: 'garden' },
      query: { cursor: scoreCursor },
    });
    expect(mocks.byTag).toHaveBeenCalledWith(
      'garden',
      null,
      decodeScoreCursor(scoreCursor),
      20,
      'recommended',
    );
  });

  it('rejects a lang the app has no locale for instead of translating into it', async () => {
    // `lang` used to be `z.string().max(8)`. `needsTranslation` returns true
    // for anything that is not en/zh, so an anonymous `?lang=xx` bought a
    // Translate call per uncached post and wrote `{"xx": ...}` into every
    // row's `translations` jsonb. Sweeping the two-letter space was an
    // unauthenticated way to grow the column and the bill without limit.
    mocks.global.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { error } = await runRoute(feedRouter, '/global', 'get', {
      query: { lang: 'fr' },
    });

    expect(error).toMatchObject({ status: 400, fields: { lang: expect.any(String) } });
    expect(mocks.global).not.toHaveBeenCalled();
  });

  it('still accepts the two languages the app ships locales for', async () => {
    mocks.global.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    for (const lang of ['en', 'zh']) {
      mocks.global.mockClear();
      const { error } = await runRoute(feedRouter, '/global', 'get', { query: { lang } });
      expect(error).toBeUndefined();
      expect(mocks.global).toHaveBeenCalledTimes(1);
    }
  });

  it('decodes a TIME cursor under latest and a SCORE cursor otherwise', async () => {
    // The decoder has to follow the sort. `paginateByTime` and
    // `paginateByScore` consume different cursor shapes, so a `latest` page
    // handed a score cursor pages from the wrong key — and the two decoders
    // are total functions that return `null` rather than throwing, so the
    // mistake would surface as a silently restarted feed, not an error.
    mocks.byBoard.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });
    const timeCursor = encodeCursor({ t: new Date(0).toISOString(), id: CURSOR_ID });
    const scoreCursor = encodeScoreCursor({ s: 5, id: CURSOR_ID });

    await runRoute(feedRouter, '/board/:slug', 'get', {
      params: { slug: 'market' },
      query: { sort: 'latest', cursor: timeCursor },
    });
    expect(mocks.byBoard.mock.calls[0][2]).toEqual(decodeCursor(timeCursor));

    await runRoute(feedRouter, '/board/:slug', 'get', {
      params: { slug: 'market' },
      query: { cursor: scoreCursor },
    });
    expect(mocks.byBoard.mock.calls[1][2]).toEqual(decodeScoreCursor(scoreCursor));
  });

  it('serves the explore summary to anonymous viewers', async () => {
    mocks.getExploreSummary.mockResolvedValue({
      featuredPost: null,
      agents: [],
      trendingTags: [],
      featuredTopics: [],
    });

    const { res, error } = await runRoute(feedRouter, '/explore-summary', 'get');

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.getExploreSummary).toHaveBeenCalledWith(null);
  });

  it('lists a user profile feed with validated params', async () => {
    mocks.byAuthor.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { res, error } = await runRoute(userPostsRouter, '/', 'get', {
      params: { username: 'ada' },
      query: { limit: '7' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.byAuthor).toHaveBeenCalledWith('ada', null, null, 7);
  });
});
