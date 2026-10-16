import type { ErrorCode } from '../contract/common';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: Record<string, string>;

  constructor(code: ErrorCode, status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.code = code;
    this.status = status;
    this.fields = fields;
    this.name = 'AppError';
  }

  static unauthenticated(message = 'Not signed in') {
    return new AppError('UNAUTHENTICATED', 401, message);
  }
  static forbidden(message = 'Not allowed') {
    return new AppError('FORBIDDEN', 403, message);
  }
  static notFound(message = 'Not found') {
    return new AppError('NOT_FOUND', 404, message);
  }
  static conflict(message: string, fields?: Record<string, string>) {
    return new AppError('CONFLICT', 409, message, fields);
  }
  static validation(message: string, fields?: Record<string, string>) {
    return new AppError('VALIDATION_ERROR', 400, message, fields);
  }
  static rateLimited(message = 'Too many requests') {
    return new AppError('RATE_LIMITED', 429, message);
  }
  /** A dependency this request needs (e.g. the translation provider) is not configured or failed. */
  static unavailable(message = 'Service unavailable') {
    return new AppError('UNAVAILABLE', 503, message);
  }

  static internal(message = 'Internal server error') {
    return new AppError('INTERNAL', 500, message);
  }
}

/** Unique indexes whose violation names one request field, for the 409 `fields` map. */
const UNIQUE_FIELD: Record<string, string> = {
  users_username_uq: 'username',
  users_email_uq: 'email',
  tags_slug_uq: 'slug',
  boards_slug_uq: 'slug',
};

/**
 * A Postgres unique violation (`23505`) as a 409, or null for anything else.
 *
 * Check-then-insert paths (register, BYOA create) can lose a race to a
 * concurrent insert; the index is the real guard and its violation is a client
 * conflict, not a server fault. drizzle wraps the driver error in
 * `DrizzleQueryError`, so the `cause` chain is walked. The driver's `detail`
 * (`Key (email)=(…)`) carries the conflicting VALUE and is never echoed.
 */
export function uniqueViolationConflict(err: unknown): AppError | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth += 1) {
    const e = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === '23505') {
      const field = typeof e.constraint === 'string' ? UNIQUE_FIELD[e.constraint] : undefined;
      return AppError.conflict('Already exists', field ? { [field]: 'Already taken' } : undefined);
    }
    cur = e.cause;
  }
  return null;
}
