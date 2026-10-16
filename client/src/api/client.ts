import axios, { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import type { ApiEnvelope, ApiError } from './types';

/**
 * Axios instance.
 *
 * Base URL is `/api/v1` in all environments; Vite proxies `/api` → :8899 in dev,
 * and in prod the static build is served by the API host itself.
 */
export const http: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api/v1',
  withCredentials: true,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

// ---- error normalization --------------------------------------------------

export function toApiError(err: unknown): ApiError {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<{
      error?: {
        code?: string;
        message?: string;
        fields?: Record<string, string>;
        requestId?: string;
      };
    }>;
    const payload = ax.response?.data?.error;
    if (payload) {
      return {
        code: (payload.code as ApiError['code']) ?? 'UNKNOWN',
        message: payload.message ?? 'Request failed',
        fields: payload.fields,
        requestId: payload.requestId,
        status: ax.response?.status ?? 0,
      };
    }
    if (ax.code === 'ECONNABORTED' || ax.code === 'ERR_NETWORK') {
      return {
        code: 'NETWORK',
        message: 'Cannot reach the server. Check your connection.',
        status: 0,
      };
    }
    return {
      code: 'UNKNOWN',
      message: ax.message || 'Request failed',
      status: ax.response?.status ?? 0,
    };
  }
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: err.message, status: 0 };
  }
  return { code: 'UNKNOWN', message: 'Unknown error', status: 0 };
}

// ---- path building ---------------------------------------------------------

/**
 * Tagged template for API paths: every interpolated value is
 * `encodeURIComponent`-ed, the literal parts are kept as written.
 *
 * React Router hands route params over already DECODED, and axios does not
 * encode a path, so a raw `/conversations/${id}/read` built from
 * `/messages/..%2Fusers%2Fx%2Ffollow%3F` became `/conversations/../users/x/follow?/read`
 * — a zero-click POST to someone else's endpoint with the viewer's cookie.
 * Every wrapper in `api/*.ts` and `features/lab/api.ts` builds its path here.
 */
export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    const segment = encodeURIComponent(String(values[i]));
    // `.` and `..` survive encoding and are still dot-segments a URL resolver
    // collapses: `/posts/${'..'}/like` would become `/like`.
    if (segment === '.' || segment === '..') {
      throw new Error(`apiPath: refusing dot-segment ${JSON.stringify(segment)}`);
    }
    out += segment + (strings[i + 1] ?? '');
  }
  return out;
}

// ---- 401 handling: coordinate session store + router ---------------------

/**
 * Endpoints whose 401 means "those credentials are wrong", not "your session
 * is gone": a mistyped current password must not sign the user out.
 */
const CREDENTIAL_CHECKS = new Set(['/auth/password', '/auth/login']);

export function isCredentialCheck(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0] ?? '';
  return CREDENTIAL_CHECKS.has(path.replace(/^.*\/api\/v1(?=\/)/, ''));
}

type UnauthorizedListener = () => void;
let unauthorizedListener: UnauthorizedListener | null = null;

export function onUnauthorized(fn: UnauthorizedListener): void {
  unauthorizedListener = fn;
}

http.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (
      err.response?.status === 401 &&
      unauthorizedListener &&
      !isCredentialCheck(err.config?.url)
    ) {
      // Defer so the interceptor doesn't hold up the axios promise chain
      queueMicrotask(() => unauthorizedListener?.());
    }
    return Promise.reject(err);
  },
);

// ---- envelope unwrapping helper ------------------------------------------

export async function unwrap<T>(p: Promise<AxiosResponse<ApiEnvelope<T>>>): Promise<T> {
  try {
    const res = await p;
    return res.data.data;
  } catch (err) {
    throw toApiError(err);
  }
}
