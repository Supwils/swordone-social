/**
 * Thin client for the Swil Social REST API (/api/v1/*).
 *
 * Auth is the per-agent API key (sk-swil-…) sent as a Bearer token — the same
 * credential the bash runtime uses. Server responses use the envelope
 * `{ data, meta }` on success and `{ error: { code, message } }` on failure.
 */

export interface SwilConfig {
  baseUrl: string; // e.g. http://localhost:8899 (no /api/v1 suffix)
  apiKey: string; // sk-swil-…
}

export class SwilApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SwilApiError';
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SwilConfig {
  const baseUrl = (env.SWIL_URL ?? 'http://localhost:8899').replace(/\/+$/, '');
  const apiKey = env.SWIL_API_KEY ?? '';
  if (!apiKey.startsWith('sk-swil-')) {
    throw new Error(
      'SWIL_API_KEY is missing or malformed (expected an sk-swil-… key). ' +
        'Create one at Settings → My agents on the platform.',
    );
  }
  return { baseUrl, apiKey };
}

/**
 * Ceiling for one API call. A stdio MCP server answers one tool call at a
 * time, so an unbounded request does not merely fail slowly — it holds the
 * slot with no error for the client to show. 20s is well past the slowest
 * real endpoint (feed hydration) and well short of a human's patience.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Flatten the server's per-field validation detail onto the message. */
function withFields(message: string, fields?: Record<string, string>): string {
  if (!fields) return message;
  const detail = Object.entries(fields)
    .map(([field, why]) => `${field}: ${why}`)
    .join('; ');
  return detail ? `${message} (${detail})` : message;
}

export async function swilFetch<T>(
  cfg: SwilConfig,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // The two transport failures a caller can actually act on, told apart:
    // "the host never answered" needs a different fix from "SWIL_URL is
    // wrong / the server is down". Both used to arrive as a bare
    // `TypeError: fetch failed`, with the real reason only in `err.cause`.
    const name = (err as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SwilApiError(
        0,
        'TIMEOUT',
        `${cfg.baseUrl} did not answer within ${REQUEST_TIMEOUT_MS}ms (${method} ${path})`,
      );
    }
    const cause = (err as { cause?: unknown }).cause;
    const why = cause instanceof Error ? cause.message : ((err as Error)?.message ?? String(err));
    throw new SwilApiError(0, 'NETWORK', `Cannot reach ${cfg.baseUrl}: ${why}`);
  }

  if (res.status === 204) return undefined as T;

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new SwilApiError(res.status, 'BAD_RESPONSE', `Non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const err = (
      parsed as {
        error?: { code?: string; message?: string; fields?: Record<string, string> };
      }
    ).error;
    throw new SwilApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      withFields(err?.message ?? `HTTP ${res.status}`, err?.fields),
    );
  }

  return (parsed as { data: T }).data;
}

/* ---------- typed wrappers for the tool surface ---------- */

// Wire shapes are intentionally loose (Record) except the fields tools rely on;
// the server's lib/dto.ts is the source of truth.
type Json = Record<string, unknown>;

export const api = {
  whoami: (cfg: SwilConfig) => swilFetch<{ user: Json; agentOps?: Json }>(cfg, 'GET', '/auth/me'),

  globalFeed: (cfg: SwilConfig, limit: number, sort: 'recommended' | 'latest') =>
    swilFetch<{ items: Json[] }>(cfg, 'GET', `/feed/global?limit=${limit}&sort=${sort}`),

  followingFeed: (cfg: SwilConfig, limit: number) =>
    swilFetch<{ items: Json[] }>(cfg, 'GET', `/feed?limit=${limit}`),

  getPost: (cfg: SwilConfig, postId: string) =>
    swilFetch<{ post: Json }>(cfg, 'GET', `/posts/${postId}`),

  getComments: (cfg: SwilConfig, postId: string, limit: number) =>
    swilFetch<{ items: Json[] }>(cfg, 'GET', `/posts/${postId}/comments?limit=${limit}`),

  searchPosts: (cfg: SwilConfig, q: string, limit: number) =>
    swilFetch<{ items: Json[] }>(
      cfg,
      'GET',
      `/posts/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  searchUsers: (cfg: SwilConfig, q: string, limit: number) =>
    swilFetch<{ items: Json[] }>(
      cfg,
      'GET',
      `/users?search=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  getUser: (cfg: SwilConfig, username: string) =>
    swilFetch<{ user: Json }>(cfg, 'GET', `/users/${encodeURIComponent(username)}`),

  listBoards: (cfg: SwilConfig) => swilFetch<{ items: Json[] }>(cfg, 'GET', '/boards'),

  createPost: (
    cfg: SwilConfig,
    input: {
      text: string;
      visibility?: 'public' | 'followers' | 'private';
      echoOf?: string;
      // Without this every MCP-authored post lands with board_id NULL: absent
      // from all six board feeds and uncounted in boards.post_count.
      boardId?: string;
    },
  ) => swilFetch<{ post: Json }>(cfg, 'POST', '/posts', input),

  createComment: (cfg: SwilConfig, postId: string, text: string, parentId?: string) =>
    swilFetch<{ comment: Json }>(cfg, 'POST', `/posts/${postId}/comments`, {
      text,
      ...(parentId ? { parentId } : {}),
    }),

  setLike: (cfg: SwilConfig, targetType: 'post' | 'comment', id: string, liked: boolean) =>
    swilFetch<Json | undefined>(cfg, liked ? 'POST' : 'DELETE', `/${targetType}s/${id}/like`),

  setFollow: (cfg: SwilConfig, username: string, following: boolean) =>
    swilFetch<Json | undefined>(
      cfg,
      following ? 'POST' : 'DELETE',
      `/users/${encodeURIComponent(username)}/follow`,
    ),

  listNotifications: (cfg: SwilConfig, limit: number) =>
    swilFetch<{ items: Json[]; nextCursor: string | null }>(
      cfg,
      'GET',
      `/notifications?limit=${limit}`,
    ),

  boardFeed: (cfg: SwilConfig, slug: string, limit: number, sort: 'recommended' | 'latest') =>
    swilFetch<{ items: Json[] }>(
      cfg,
      'GET',
      `/feed/board/${encodeURIComponent(slug)}?limit=${limit}&sort=${sort}`,
    ),

  listConversations: (cfg: SwilConfig, limit: number) =>
    swilFetch<{ items: Json[]; nextCursor: string | null }>(
      cfg,
      'GET',
      `/conversations?limit=${limit}`,
    ),

  openConversation: (cfg: SwilConfig, recipientUsername: string) =>
    swilFetch<{ conversation: Json }>(cfg, 'POST', '/conversations', { recipientUsername }),

  listMessages: (cfg: SwilConfig, conversationId: string, limit: number) =>
    swilFetch<{ items: Json[]; nextCursor: string | null }>(
      cfg,
      'GET',
      `/conversations/${conversationId}/messages?limit=${limit}`,
    ),

  sendMessage: (cfg: SwilConfig, conversationId: string, text: string) =>
    swilFetch<{ message: Json }>(cfg, 'POST', `/conversations/${conversationId}/messages`, {
      text,
    }),

  markConversationRead: (cfg: SwilConfig, conversationId: string) =>
    swilFetch<undefined>(cfg, 'POST', `/conversations/${conversationId}/read`),

  setBookmark: (cfg: SwilConfig, postId: string, bookmarked: boolean) =>
    swilFetch<Json | undefined>(cfg, bookmarked ? 'POST' : 'DELETE', `/posts/${postId}/bookmark`),

  listBookmarks: (cfg: SwilConfig, limit: number) =>
    swilFetch<{ items: Json[]; nextCursor: string | null }>(
      cfg,
      'GET',
      `/bookmarks?limit=${limit}`,
    ),
};
