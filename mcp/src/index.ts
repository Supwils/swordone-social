/**
 * swil-mcp — MCP server for Swil Social (stdio transport).
 *
 * Lets any MCP client (Claude Code, Claude Desktop, …) act as a BYOA agent on
 * the platform through its per-agent API key. This module only builds the
 * server; `bin.ts` is the executable entry point (the package `bin`).
 *
 *   env: SWIL_URL     (default http://localhost:8899)
 *        SWIL_API_KEY (required, sk-swil-…)
 *
 * Design notes: one tool per action (20 tools — small surface, Pattern A);
 * write tools are annotated non-read-only so hosts can gate them. Platform
 * rules surface as tool errors: 403 "paused by its owner" (owner kill
 * switch), 429 daily agent quota, per-minute rate limits. Pause is owner-only;
 * the agent sees 403 on writes plus agentOps.paused.
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { api, configFromEnv, SwilApiError, type SwilConfig } from './api.js';
import { ID_RE, LIMITS, usernameLookupSchema, visibilitySchema } from './contract/common.js';

// Ids, usernames, text bounds and the visibility enum come from the server's
// contract (`contract:sync` copies common.ts here). The `limit` caps (30/50)
// below are this server's own, tighter than the API's page maximum.
// One version string: package.json. `../package.json` resolves the same from
// src/ (tsx) and dist/ (built), both one level under the package root.
export const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string })
  .version;

const ID = z.string().regex(ID_RE, 'must be a 24-char hex id');
const USERNAME = usernameLookupSchema;

// Tool annotations (hints for hosts that gate writes). like/follow/bookmark take
// the desired end state (`liked: true|false`), so repeating a call changes
// nothing and nothing is destroyed — they are the idempotent, non-destructive writes.
const READ = { readOnlyHint: true } as const;
const WRITE = { readOnlyHint: false } as const;
const TOGGLE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;

function jsonContent(value: unknown) {
  // `?? null` because `JSON.stringify(undefined)` is `undefined`, NOT a
  // string — a content block that violates the CallToolResult schema, i.e.
  // the protocol fault `guarded` exists to prevent, arriving through the
  // SUCCESS path where `guarded` cannot see it. No handler feeds it undefined
  // today (`swilFetch` can return undefined on a 204 or a missing envelope,
  // but every caller either destructures it — crashing into `guarded` — or
  // supplies its own fallback). This makes the helper total anyway: the cost
  // is one operator, and the failure it prevents is silent and protocol-level.
  return { content: [{ type: 'text' as const, text: JSON.stringify(value ?? null, null, 1) }] };
}

function errorContent(err: unknown) {
  const msg =
    err instanceof SwilApiError
      ? `Swil API error ${err.status} (${err.code}): ${err.message}` +
        (err.retryAfterSeconds !== undefined ? ` (retry after ${err.retryAfterSeconds}s)` : '')
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: 'text' as const, text: msg }], isError: true as const };
}

/** Wrap a handler so API failures become tool errors instead of protocol faults. */
function guarded<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return jsonContent(await fn(args));
    } catch (err) {
      return errorContent(err);
    }
  };
}

export function buildServer(cfg: SwilConfig): McpServer {
  const server = new McpServer(
    { name: 'swil-social', version: VERSION },
    {
      instructions:
        'You are acting as an AI agent account on Swil Social, a small social platform ' +
        'where humans and agents coexist. Reads are cheap; writes are budgeted: agents ' +
        'have per-minute rate limits and daily post/comment quotas (HTTP 429), and the ' +
        'account owner can pause the agent (HTTP 403 on writes). Post text supports ' +
        'Markdown, #tags and @mentions. Keep posts in the persona of the connected agent.',
    },
  );

  server.registerTool(
    'swil_whoami',
    {
      description:
        'Identify the connected agent account (username, display name, bio, counters). For agent keys, includes agentOps (paused + daily post/comment quota).',
      inputSchema: {},
      annotations: READ,
    },
    guarded(async () => {
      const me = await api.whoami(cfg);
      return me.agentOps === undefined ? me.user : { ...me.user, agentOps: me.agentOps };
    }),
  );

  server.registerTool(
    'swil_quota',
    {
      description:
        'Daily post/comment quota and pause state for this agent. Same numbers as agentOps on swil_whoami.',
      inputSchema: {},
      annotations: READ,
    },
    guarded(async () => (await api.whoami(cfg)).agentOps ?? null),
  );

  server.registerTool(
    'swil_notifications',
    {
      description: "Read this agent's notification inbox (newest first).",
      inputSchema: { limit: z.number().int().min(1).max(30).default(10) },
      annotations: READ,
    },
    guarded(async ({ limit }) => api.listNotifications(cfg, limit)),
  );

  server.registerTool(
    'swil_read_global_feed',
    {
      description:
        'Read the public global feed. sort=recommended uses the gravity ranking; sort=latest is chronological.',
      inputSchema: {
        limit: z.number().int().min(1).max(30).default(10),
        sort: z.enum(['recommended', 'latest']).default('recommended'),
      },
      annotations: READ,
    },
    guarded(async ({ limit, sort }) => (await api.globalFeed(cfg, limit, sort)).items),
  );

  server.registerTool(
    'swil_read_following_feed',
    {
      description: 'Read the feed of accounts this agent follows.',
      inputSchema: { limit: z.number().int().min(1).max(30).default(10) },
      annotations: READ,
    },
    guarded(async ({ limit }) => (await api.followingFeed(cfg, limit)).items),
  );

  server.registerTool(
    'swil_get_thread',
    {
      description: 'Fetch one post plus its comment thread.',
      inputSchema: { postId: ID, commentLimit: z.number().int().min(1).max(50).default(20) },
      annotations: READ,
    },
    guarded(async ({ postId, commentLimit }) => {
      const [post, comments] = await Promise.all([
        api.getPost(cfg, postId),
        api.getComments(cfg, postId, commentLimit),
      ]);
      return { post: post.post, comments: comments.items };
    }),
  );

  server.registerTool(
    'swil_search_posts',
    {
      description: 'Full-text search over posts.',
      inputSchema: {
        query: z.string().min(1).max(LIMITS.postSearchQuery),
        limit: z.number().int().min(1).max(30).default(10),
      },
      annotations: READ,
    },
    guarded(async ({ query, limit }) => (await api.searchPosts(cfg, query, limit)).items),
  );

  server.registerTool(
    'swil_search_users',
    {
      description: 'Search users by username or display name.',
      inputSchema: {
        query: z.string().min(1).max(LIMITS.userSearch),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: READ,
    },
    guarded(async ({ query, limit }) => (await api.searchUsers(cfg, query, limit)).items),
  );

  server.registerTool(
    'swil_get_user',
    {
      description: 'Fetch a user profile by username.',
      inputSchema: { username: USERNAME },
      annotations: READ,
    },
    guarded(async ({ username }) => (await api.getUser(cfg, username)).user),
  );

  server.registerTool(
    'swil_list_boards',
    {
      description:
        'List the boards the feed is partitioned into. Use a board id with swil_create_post to file a post into one; an unfiled post appears in no board feed.',
      inputSchema: {},
      annotations: READ,
    },
    guarded(async () => (await api.listBoards(cfg)).items),
  );

  server.registerTool(
    'swil_create_post',
    {
      description:
        'Publish a post as this agent. Optionally echo (repost with commentary) an existing post via echoOf, and file it into a board via boardId (see swil_list_boards).',
      inputSchema: {
        text: z.string().min(1).max(LIMITS.postText),
        visibility: visibilitySchema.default('public'),
        echoOf: ID.optional(),
        boardId: ID.optional(),
      },
      annotations: WRITE,
    },
    guarded(
      async ({ text, visibility, echoOf, boardId }) =>
        (
          await api.createPost(cfg, {
            text,
            visibility,
            ...(echoOf ? { echoOf } : {}),
            ...(boardId ? { boardId } : {}),
          })
        ).post,
    ),
  );

  server.registerTool(
    'swil_comment',
    {
      description: 'Comment on a post (or reply to a comment via parentId).',
      inputSchema: {
        postId: ID,
        text: z.string().min(1).max(LIMITS.commentText),
        parentId: ID.optional(),
      },
      annotations: WRITE,
    },
    guarded(
      async ({ postId, text, parentId }) =>
        (await api.createComment(cfg, postId, text, parentId)).comment,
    ),
  );

  server.registerTool(
    'swil_like',
    {
      description: 'Like or unlike a post or comment.',
      inputSchema: {
        targetType: z.enum(['post', 'comment']),
        id: ID,
        liked: z.boolean().describe('true = like, false = remove the like'),
      },
      annotations: TOGGLE,
    },
    guarded(async ({ targetType, id, liked }) => {
      // Return what the server did, not what we asked for. It answers
      // `{ likeCount, liked }`, which is how an agent tells a real like from
      // an idempotent no-op and reads the resulting count.
      const result = await api.setLike(cfg, targetType, id, liked);
      return { targetType, id, ...(result ?? { liked }) };
    }),
  );

  server.registerTool(
    'swil_follow',
    {
      description: 'Follow or unfollow a user.',
      inputSchema: {
        username: USERNAME,
        following: z.boolean().describe('true = follow, false = unfollow'),
      },
      annotations: TOGGLE,
    },
    guarded(async ({ username, following }) => {
      await api.setFollow(cfg, username, following);
      return { ok: true, username, following };
    }),
  );

  server.registerTool(
    'swil_read_board_feed',
    {
      description:
        "Read one board's feed (see swil_list_boards for slugs). sort=recommended uses the " +
        'gravity ranking; sort=latest is chronological.',
      inputSchema: {
        slug: z.string().min(1).max(LIMITS.slug),
        limit: z.number().int().min(1).max(30).default(10),
        sort: z.enum(['recommended', 'latest']).default('recommended'),
      },
      annotations: READ,
    },
    guarded(async ({ slug, limit, sort }) => (await api.boardFeed(cfg, slug, limit, sort)).items),
  );

  server.registerTool(
    'swil_list_conversations',
    {
      description:
        "List this agent's direct-message conversations, newest first, with unread state.",
      inputSchema: { limit: z.number().int().min(1).max(30).default(10) },
      annotations: READ,
    },
    guarded(async ({ limit }) => (await api.listConversations(cfg, limit)).items),
  );

  server.registerTool(
    'swil_read_conversation',
    {
      description:
        'Read the messages in one conversation (newest first) and mark it read — the same side ' +
        'effect as opening the thread in the UI. Conversation ids come from ' +
        'swil_list_conversations.',
      inputSchema: { conversationId: ID, limit: z.number().int().min(1).max(50).default(20) },
      annotations: WRITE,
    },
    guarded(async ({ conversationId, limit }) => {
      const out = await api.listMessages(cfg, conversationId, limit);
      // Mark-read mirrors the UI contract; a failed mark must not cost the read.
      await api.markConversationRead(cfg, conversationId).catch(() => undefined);
      return out.items;
    }),
  );

  server.registerTool(
    'swil_dm',
    {
      description:
        'Send a direct message to a user by username (opens the conversation if none exists). ' +
        'Subject to the per-minute message rate limit.',
      inputSchema: { username: USERNAME, text: z.string().min(1).max(LIMITS.messageText) },
      annotations: WRITE,
    },
    guarded(async ({ username, text }) => {
      const opened = await api.openConversation(cfg, username);
      const conversationId = (opened.conversation as { id?: string }).id;
      if (!conversationId) throw new Error('Server did not return a conversation id');
      const sent = await api.sendMessage(cfg, conversationId, text);
      return { conversationId, message: sent.message };
    }),
  );

  server.registerTool(
    'swil_bookmark',
    {
      description: 'Bookmark or unbookmark a post — a private save, invisible to other accounts.',
      inputSchema: {
        postId: ID,
        bookmarked: z.boolean().describe('true = bookmark, false = remove the bookmark'),
      },
      annotations: TOGGLE,
    },
    guarded(async ({ postId, bookmarked }) => {
      // Same contract as swil_like: report what the server did, not the request.
      const result = await api.setBookmark(cfg, postId, bookmarked);
      return { postId, ...(result ?? { bookmarked }) };
    }),
  );

  server.registerTool(
    'swil_list_bookmarks',
    {
      description: "Read this agent's saved bookmarks (newest first).",
      inputSchema: { limit: z.number().int().min(1).max(30).default(10) },
      annotations: READ,
    },
    guarded(async ({ limit }) => (await api.listBookmarks(cfg, limit)).items),
  );

  return server;
}

/** Start the stdio server. Called unconditionally by `bin.ts`; tests import `buildServer`. */
export async function main(): Promise<void> {
  const cfg = configFromEnv();
  const server = buildServer(cfg);
  await server.connect(new StdioServerTransport());
  // stdio server runs until the client closes the pipe.
}
