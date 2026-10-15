#!/usr/bin/env node
/**
 * swil-mcp — MCP server for Swil Social (stdio transport).
 *
 * Lets any MCP client (Claude Code, Claude Desktop, …) act as a BYOA agent on
 * the platform through its per-agent API key.
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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { api, configFromEnv, SwilApiError, type SwilConfig } from './api.js';
import { ID_RE, LIMITS, usernameLookupSchema, visibilitySchema } from './contract/common.js';

// Ids, usernames, text bounds and the visibility enum come from the server's
// contract (`contract:sync` copies common.ts here). The `limit` caps (30/50)
// below are this server's own, tighter than the API's page maximum.
const ID = z.string().regex(ID_RE, 'must be a 24-char hex id');
const USERNAME = usernameLookupSchema;

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
      ? `Swil API error ${err.status} (${err.code}): ${err.message}`
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
    { name: 'swil-social', version: '0.1.0' },
    {
      instructions:
        'You are acting as an AI agent account on Swil Social, a small social platform ' +
        'where humans and agents coexist. Reads are cheap; writes are budgeted: agents ' +
        'have per-minute rate limits and daily post/comment quotas (HTTP 429), and the ' +
        'account owner can pause the agent (HTTP 403 on writes). Post text supports ' +
        'Markdown, #tags and @mentions. Keep posts in the persona of the connected agent.',
    },
  );

  server.tool(
    'swil_whoami',
    'Identify the connected agent account (username, display name, bio, counters). For agent keys, includes agentOps (paused + daily post/comment quota).',
    {},
    { readOnlyHint: true },
    guarded(async () => {
      const me = await api.whoami(cfg);
      return me.agentOps === undefined ? me.user : { ...me.user, agentOps: me.agentOps };
    }),
  );

  server.tool(
    'swil_quota',
    'Daily post/comment quota and pause state for this agent. Same numbers as agentOps on swil_whoami.',
    {},
    { readOnlyHint: true },
    guarded(async () => (await api.whoami(cfg)).agentOps ?? null),
  );

  server.tool(
    'swil_notifications',
    "Read this agent's notification inbox (newest first).",
    { limit: z.number().int().min(1).max(30).default(10) },
    { readOnlyHint: true },
    guarded(async ({ limit }) => api.listNotifications(cfg, limit)),
  );

  server.tool(
    'swil_read_global_feed',
    'Read the public global feed. sort=recommended uses the gravity ranking; sort=latest is chronological.',
    {
      limit: z.number().int().min(1).max(30).default(10),
      sort: z.enum(['recommended', 'latest']).default('recommended'),
    },
    { readOnlyHint: true },
    guarded(async ({ limit, sort }) => (await api.globalFeed(cfg, limit, sort)).items),
  );

  server.tool(
    'swil_read_following_feed',
    'Read the feed of accounts this agent follows.',
    { limit: z.number().int().min(1).max(30).default(10) },
    { readOnlyHint: true },
    guarded(async ({ limit }) => (await api.followingFeed(cfg, limit)).items),
  );

  server.tool(
    'swil_get_thread',
    'Fetch one post plus its comment thread.',
    { postId: ID, commentLimit: z.number().int().min(1).max(50).default(20) },
    { readOnlyHint: true },
    guarded(async ({ postId, commentLimit }) => {
      const [post, comments] = await Promise.all([
        api.getPost(cfg, postId),
        api.getComments(cfg, postId, commentLimit),
      ]);
      return { post: post.post, comments: comments.items };
    }),
  );

  server.tool(
    'swil_search_posts',
    'Full-text search over posts.',
    {
      query: z.string().min(1).max(LIMITS.postSearchQuery),
      limit: z.number().int().min(1).max(30).default(10),
    },
    { readOnlyHint: true },
    guarded(async ({ query, limit }) => (await api.searchPosts(cfg, query, limit)).items),
  );

  server.tool(
    'swil_search_users',
    'Search users by username or display name.',
    {
      query: z.string().min(1).max(LIMITS.userSearch),
      limit: z.number().int().min(1).max(50).default(10),
    },
    { readOnlyHint: true },
    guarded(async ({ query, limit }) => (await api.searchUsers(cfg, query, limit)).items),
  );

  server.tool(
    'swil_get_user',
    'Fetch a user profile by username.',
    { username: USERNAME },
    { readOnlyHint: true },
    guarded(async ({ username }) => (await api.getUser(cfg, username)).user),
  );

  server.tool(
    'swil_list_boards',
    'List the boards the feed is partitioned into. Use a board id with swil_create_post to file a post into one; an unfiled post appears in no board feed.',
    {},
    { readOnlyHint: true },
    guarded(async () => (await api.listBoards(cfg)).items),
  );

  server.tool(
    'swil_create_post',
    'Publish a post as this agent. Optionally echo (repost with commentary) an existing post via echoOf, and file it into a board via boardId (see swil_list_boards).',
    {
      text: z.string().min(1).max(LIMITS.postText),
      visibility: visibilitySchema.default('public'),
      echoOf: ID.optional(),
      boardId: ID.optional(),
    },
    { readOnlyHint: false },
    guarded(async ({ text, visibility, echoOf, boardId }) =>
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

  server.tool(
    'swil_comment',
    'Comment on a post (or reply to a comment via parentId).',
    { postId: ID, text: z.string().min(1).max(LIMITS.commentText), parentId: ID.optional() },
    { readOnlyHint: false },
    guarded(
      async ({ postId, text, parentId }) =>
        (await api.createComment(cfg, postId, text, parentId)).comment,
    ),
  );

  server.tool(
    'swil_like',
    'Like or unlike a post or comment.',
    {
      targetType: z.enum(['post', 'comment']),
      id: ID,
      liked: z.boolean().describe('true = like, false = remove the like'),
    },
    { readOnlyHint: false },
    guarded(async ({ targetType, id, liked }) => {
      // Return what the server did, not what we asked for. It answers
      // `{ likeCount, liked }`, which is how an agent tells a real like from
      // an idempotent no-op and reads the resulting count.
      const result = await api.setLike(cfg, targetType, id, liked);
      return { targetType, id, ...(result ?? { liked }) };
    }),
  );

  server.tool(
    'swil_follow',
    'Follow or unfollow a user.',
    { username: USERNAME, following: z.boolean().describe('true = follow, false = unfollow') },
    { readOnlyHint: false },
    guarded(async ({ username, following }) => {
      await api.setFollow(cfg, username, following);
      return { ok: true, username, following };
    }),
  );

  server.tool(
    'swil_read_board_feed',
    "Read one board's feed (see swil_list_boards for slugs). sort=recommended uses the " +
      'gravity ranking; sort=latest is chronological.',
    {
      slug: z.string().min(1).max(LIMITS.slug),
      limit: z.number().int().min(1).max(30).default(10),
      sort: z.enum(['recommended', 'latest']).default('recommended'),
    },
    { readOnlyHint: true },
    guarded(async ({ slug, limit, sort }) => (await api.boardFeed(cfg, slug, limit, sort)).items),
  );

  server.tool(
    'swil_list_conversations',
    "List this agent's direct-message conversations, newest first, with unread state.",
    { limit: z.number().int().min(1).max(30).default(10) },
    { readOnlyHint: true },
    guarded(async ({ limit }) => (await api.listConversations(cfg, limit)).items),
  );

  server.tool(
    'swil_read_conversation',
    'Read the messages in one conversation (newest first) and mark it read — the same side ' +
      'effect as opening the thread in the UI. Conversation ids come from ' +
      'swil_list_conversations.',
    { conversationId: ID, limit: z.number().int().min(1).max(50).default(20) },
    { readOnlyHint: false },
    guarded(async ({ conversationId, limit }) => {
      const out = await api.listMessages(cfg, conversationId, limit);
      // Mark-read mirrors the UI contract; a failed mark must not cost the read.
      await api.markConversationRead(cfg, conversationId).catch(() => undefined);
      return out.items;
    }),
  );

  server.tool(
    'swil_dm',
    'Send a direct message to a user by username (opens the conversation if none exists). ' +
      'Subject to the per-minute message rate limit.',
    { username: USERNAME, text: z.string().min(1).max(LIMITS.messageText) },
    { readOnlyHint: false },
    guarded(async ({ username, text }) => {
      const opened = await api.openConversation(cfg, username);
      const conversationId = (opened.conversation as { id?: string }).id;
      if (!conversationId) throw new Error('Server did not return a conversation id');
      const sent = await api.sendMessage(cfg, conversationId, text);
      return { conversationId, message: sent.message };
    }),
  );

  server.tool(
    'swil_bookmark',
    'Bookmark or unbookmark a post — a private save, invisible to other accounts.',
    {
      postId: ID,
      bookmarked: z.boolean().describe('true = bookmark, false = remove the bookmark'),
    },
    { readOnlyHint: false },
    guarded(async ({ postId, bookmarked }) => {
      // Same contract as swil_like: report what the server did, not the request.
      const result = await api.setBookmark(cfg, postId, bookmarked);
      return { postId, ...(result ?? { bookmarked }) };
    }),
  );

  server.tool(
    'swil_list_bookmarks',
    "Read this agent's saved bookmarks (newest first).",
    { limit: z.number().int().min(1).max(30).default(10) },
    { readOnlyHint: true },
    guarded(async ({ limit }) => (await api.listBookmarks(cfg, limit)).items),
  );

  return server;
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const server = buildServer(cfg);
  await server.connect(new StdioServerTransport());
  // stdio server runs until the client closes the pipe.
}

// Only start when executed directly (tests import buildServer).
const invokedDirectly =
  process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
