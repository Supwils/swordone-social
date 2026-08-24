export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

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
