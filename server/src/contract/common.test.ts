import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envelopeData, expectContract } from '../test/contract';
import {
  ERROR_CODES,
  ErrorBodySchema,
  ID_RE,
  LIMITS,
  LOCALES,
  VISIBILITIES,
  envelope,
  localeSchema,
  paginated,
  usernameLookupSchema,
  usernameSchema,
  visibilitySchema,
} from './common';

describe('common enums', () => {
  it('pins the values', () => {
    expect(LOCALES).toEqual(['en', 'zh']);
    expect(VISIBILITIES).toEqual(['public', 'followers', 'private']);
    expect(ERROR_CODES).toEqual([
      'VALIDATION_ERROR',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'RATE_LIMITED',
      'UNAVAILABLE',
      'INTERNAL',
    ]);
  });

  it('parses members and rejects others', () => {
    expect(expectContract(localeSchema, 'zh')).toBe('zh');
    expect(() => expectContract(localeSchema, 'fr')).toThrow('<root>');
    expect(expectContract(visibilitySchema, 'followers')).toBe('followers');
    expect(() => expectContract(visibilitySchema, 'unlisted')).toThrow('<root>');
  });
});

describe('ErrorBodySchema', () => {
  it('accepts the errorHandler shape with and without fields / requestId', () => {
    const withFields = {
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', fields: { text: 'Required' } },
    };
    expect(expectContract(ErrorBodySchema, withFields)).toEqual(withFields);
    expect(
      expectContract(ErrorBodySchema, {
        error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r1' },
      }).error.code,
    ).toBe('NOT_FOUND');
  });

  it('rejects an unknown code and a leaked key', () => {
    expect(() =>
      expectContract(ErrorBodySchema, { error: { code: 'TEAPOT', message: 'x' } }),
    ).toThrow('error.code:');
    expect(() =>
      expectContract(ErrorBodySchema, { error: { code: 'INTERNAL', message: 'x', stack: 's' } }),
    ).toThrow("'stack'");
  });
});

describe('envelope / paginated', () => {
  const item = z.object({ id: z.string() }).strict();
  const page = envelope(paginated(item));

  it('accepts the ok() envelope around a cursor page', () => {
    const body = { data: { items: [{ id: 'a' }], nextCursor: null }, meta: {} };
    expect(expectContract(page, body)).toEqual(body);
    expect(
      expectContract(page, { data: { items: [], nextCursor: 'c' }, meta: { requestId: 'r' } }).data
        .nextCursor,
    ).toBe('c');
  });

  it('names the path of a bad item and rejects extra keys', () => {
    expect(() =>
      expectContract(page, { data: { items: [{ id: 1 }], nextCursor: null }, meta: {} }),
    ).toThrow('data.items.0.id:');
    expect(() =>
      expectContract(page, { data: { items: [], nextCursor: null, total: 0 }, meta: {} }),
    ).toThrow("'total'");
    expect(() => expectContract(page, { data: { items: [] }, meta: {} })).toThrow(
      'data.nextCursor: Required',
    );
  });
});

describe('envelopeData', () => {
  it('returns data from an ok() envelope', () => {
    expect(envelopeData({ data: { id: 'a' }, meta: { requestId: 'r' } })).toEqual({ id: 'a' });
  });

  it('rejects a missing meta, a missing data and an extra top-level key', () => {
    expect(() => envelopeData({ data: {} })).toThrow('meta: Required');
    expect(() => envelopeData({ meta: {} })).toThrow('data: Required');
    expect(() => envelopeData({ data: {}, meta: {}, error: {} })).toThrow("'error'");
  });
});

describe('ids, usernames, limits', () => {
  it('ID_RE matches a 24-char lowercase hex id only', () => {
    expect(ID_RE.test('0123456789abcdef01234567')).toBe(true);
    expect(ID_RE.test('0123456789ABCDEF01234567')).toBe(false);
    expect(ID_RE.test('0123456789abcdef0123456')).toBe(false);
  });

  it('pins the limits the request schemas enforce', () => {
    expect(LIMITS).toEqual({
      usernameMin: 3,
      usernameMax: 24,
      postText: 5000,
      commentText: 2000,
      messageText: 4000,
      postSearchQuery: 100,
      userSearch: 32,
      slug: 64,
    });
  });

  it('usernameSchema keeps its sign-up message; the lookup variant keeps the zod default', () => {
    expect(expectContract(usernameSchema, 'ada_99')).toBe('ada_99');
    expect(expectContract(usernameLookupSchema, 'ada_99')).toBe('ada_99');
    expect(() => expectContract(usernameSchema, 'ad')).toThrow('<root>');
    expect(() => expectContract(usernameSchema, 'a'.repeat(25))).toThrow('<root>');

    const signUp = usernameSchema.safeParse('bad-name');
    const lookup = usernameLookupSchema.safeParse('bad-name');
    expect(signUp.error?.issues[0].message).toBe('Letters, numbers, and underscores only');
    expect(lookup.error?.issues[0].message).toBe('Invalid');
  });
});
