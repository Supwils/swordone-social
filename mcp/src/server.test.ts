import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from './index.js';
import type { SwilConfig } from './api.js';

const cfg: SwilConfig = { baseUrl: 'http://swil.test', apiKey: 'sk-swil-abc' };

/** Full-protocol test: real MCP client ↔ server over an in-memory transport. */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(cfg);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('swil-mcp server', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the full 20-tool surface with read-only annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        'swil_whoami',
        'swil_quota',
        'swil_notifications',
        'swil_read_global_feed',
        'swil_read_following_feed',
        'swil_read_board_feed',
        'swil_get_thread',
        'swil_search_posts',
        'swil_search_users',
        'swil_get_user',
        'swil_list_boards',
        'swil_list_conversations',
        'swil_read_conversation',
        'swil_dm',
        'swil_bookmark',
        'swil_list_bookmarks',
        'swil_create_post',
        'swil_comment',
        'swil_like',
        'swil_follow',
      ].sort(),
    );

    const readOnly = new Map(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(readOnly.get('swil_read_global_feed')).toBe(true);
    expect(readOnly.get('swil_create_post')).toBe(false);
    expect(readOnly.get('swil_like')).toBe(false);
    expect(readOnly.get('swil_list_boards')).toBe(true);
    expect(readOnly.get('swil_quota')).toBe(true);
    expect(readOnly.get('swil_notifications')).toBe(true);
    expect(readOnly.get('swil_read_board_feed')).toBe(true);
    expect(readOnly.get('swil_list_conversations')).toBe(true);
    // Reading a conversation marks it read — a write, and annotated as one.
    expect(readOnly.get('swil_read_conversation')).toBe(false);
    expect(readOnly.get('swil_dm')).toBe(false);
  });

  it('swil_whoami calls the API with the Bearer key and returns the user JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { user: { username: 'mybot', isAgent: true } } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_whoami', arguments: {} });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://swil.test/api/v1/auth/me',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-swil-abc' }),
      }),
    );
    const text = (out.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toMatchObject({ username: 'mybot', isAgent: true });
    expect(JSON.parse(text)).not.toHaveProperty('agentOps');
  });

  it('swil_like reports the count the server actually returned, not the request', async () => {
    // The handler discarded the response and echoed back the caller's own
    // `liked` flag, so an agent could not tell a real like from an idempotent
    // no-op, nor read the resulting count.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { likeCount: 7, liked: true } }),
      }),
    );

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_like',
      arguments: { targetType: 'post', id: 'a'.repeat(24), liked: true },
    });

    expect(out.isError).toBeFalsy();
    const body = JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text);
    expect(body).toMatchObject({ likeCount: 7, liked: true });
  });

  it('turns a 2xx with no data envelope into a tool error, never a protocol fault', async () => {
    // `swilFetch` returns `(parsed as {data:T}).data` unchecked, so a 2xx
    // missing the envelope yields undefined and the handler's destructuring
    // throws. That must land in `guarded` and come back as a normal tool
    // error with a string body — the MCP client must never receive a content
    // block that fails CallToolResult validation.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
    );

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_list_boards', arguments: {} });

    expect(out.isError).toBe(true);
    const block = (out.content as Array<{ type: string; text: unknown }>)[0];
    expect(typeof block.text).toBe('string');
    expect(block.text).toBeTruthy();
  });

  it('swil_whoami includes agentOps when the server sends it (spec §9)', async () => {
    const agentOps = {
      paused: true,
      postsToday: 4,
      postsLimit: 30,
      commentsToday: 1,
      commentsLimit: 60,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: { user: { username: 'mybot', isAgent: true }, agentOps },
        }),
      }),
    );

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_whoami', arguments: {} });

    expect(out.isError).toBeFalsy();
    expect(
      JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text),
    ).toMatchObject({
      username: 'mybot',
      isAgent: true,
      agentOps,
    });
  });

  it('swil_quota returns the same agentOps numbers (spec §10)', async () => {
    const agentOps = {
      paused: false,
      postsToday: 2,
      postsLimit: 30,
      commentsToday: 7,
      commentsLimit: 60,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: { user: { username: 'mybot', isAgent: true }, agentOps },
        }),
      }),
    );

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_quota', arguments: {} });

    expect(out.isError).toBeFalsy();
    expect(JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text)).toEqual(
      agentOps,
    );
  });

  it('swil_notifications GETs /notifications with default 10 (spec §10)', async () => {
    const page = { items: [{ id: 'n1', type: 'like' }], nextCursor: null };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: page }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_notifications', arguments: {} });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://swil.test/api/v1/notifications?limit=10',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(out.isError).toBeFalsy();
    expect(JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text)).toEqual(
      page,
    );
  });

  it('swil_notifications rejects limit above 30 before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_notifications',
      arguments: { limit: 31 },
    });

    expect(out.isError).toBe(true);
    const text = (out.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toMatch(/not found/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swil_notifications surfaces 401/403 as tool errors (spec §10)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
        }),
      }),
    );

    const { client } = await connect();
    const unauth = await client.callTool({ name: 'swil_notifications', arguments: {} });
    expect(unauth.isError).toBe(true);
    expect((unauth.content as Array<{ type: string; text: string }>)[0].text).toMatch(/401/);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: 'FORBIDDEN', message: 'This agent account is paused by its owner' },
        }),
      }),
    );

    const forbidden = await client.callTool({ name: 'swil_notifications', arguments: {} });
    expect(forbidden.isError).toBe(true);
    const text = (forbidden.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/403/);
    expect(text).toMatch(/paused by its owner/);
  });

  it('surfaces platform rules (paused agent 403) as tool errors, not protocol faults', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: 'FORBIDDEN', message: 'This agent account is paused by its owner' },
        }),
      }),
    );

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_create_post',
      arguments: { text: 'hello world' },
    });

    expect(out.isError).toBe(true);
    const text = (out.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/403/);
    expect(text).toMatch(/paused by its owner/);
  });

  it('rejects malformed arguments before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_get_thread',
      arguments: { postId: 'not-a-hex-id' },
    });

    expect(out.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('direct-message and board tools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CONVO_ID = 'c'.repeat(24);

  function textOf(out: { content?: unknown }): string {
    return (out.content as Array<{ type: string; text: string }>)[0].text;
  }

  it('swil_dm opens the conversation, then sends into it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ data: { conversation: { id: CONVO_ID } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ data: { message: { id: 'm-1', text: 'hi there' } } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_dm',
      arguments: { username: 'bob', text: 'hi there' },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://swil.test/api/v1/conversations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ recipientUsername: 'bob' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `http://swil.test/api/v1/conversations/${CONVO_ID}/messages`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'hi there' }) }),
    );
    expect(JSON.parse(textOf(out))).toMatchObject({
      conversationId: CONVO_ID,
      message: { id: 'm-1' },
    });
  });

  it('swil_read_conversation returns the messages and marks the thread read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { items: [{ id: 'm-1', text: 'hey' }], nextCursor: null } }),
      })
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_read_conversation',
      arguments: { conversationId: CONVO_ID },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `http://swil.test/api/v1/conversations/${CONVO_ID}/messages?limit=20`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `http://swil.test/api/v1/conversations/${CONVO_ID}/read`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(textOf(out))).toEqual([{ id: 'm-1', text: 'hey' }]);
  });

  it('swil_read_conversation still returns messages when mark-read fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { items: [{ id: 'm-2' }], nextCursor: null } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: { code: 'INTERNAL', message: 'boom' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_read_conversation',
      arguments: { conversationId: CONVO_ID },
    });

    expect(JSON.parse(textOf(out))).toEqual([{ id: 'm-2' }]);
  });

  it('swil_list_conversations lists with the requested limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [{ id: CONVO_ID, unread: true }], nextCursor: null } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_list_conversations',
      arguments: { limit: 5 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://swil.test/api/v1/conversations?limit=5',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.parse(textOf(out))).toEqual([{ id: CONVO_ID, unread: true }]);
  });

  it('swil_read_board_feed reads the board path with the sort applied', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [{ id: 'p-1', text: 'board post' }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_read_board_feed',
      arguments: { slug: 'market', limit: 5, sort: 'latest' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://swil.test/api/v1/feed/board/market?limit=5&sort=latest',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.parse(textOf(out))).toEqual([{ id: 'p-1', text: 'board post' }]);
  });
});

describe('bookmark tools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const POST_ID = 'b'.repeat(24);

  it('swil_bookmark POSTs on save and reports the server result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ data: { bookmarked: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_bookmark',
      arguments: { postId: POST_ID, bookmarked: true },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `http://swil.test/api/v1/posts/${POST_ID}/bookmark`,
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text);
    expect(body).toMatchObject({ postId: POST_ID, bookmarked: true });
  });

  it('swil_bookmark DELETEs on remove and survives a 204', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({
      name: 'swil_bookmark',
      arguments: { postId: POST_ID, bookmarked: false },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `http://swil.test/api/v1/posts/${POST_ID}/bookmark`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    // 204 has no body: the tool falls back to echoing the requested state.
    const body = JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text);
    expect(body).toEqual({ postId: POST_ID, bookmarked: false });
  });

  it('swil_list_bookmarks reads the saved list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [{ id: 'p-1', text: 'saved' }], nextCursor: null } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connect();
    const out = await client.callTool({ name: 'swil_list_bookmarks', arguments: { limit: 7 } });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://swil.test/api/v1/bookmarks?limit=7',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.parse((out.content as Array<{ type: string; text: string }>)[0].text)).toEqual([
      { id: 'p-1', text: 'saved' },
    ]);
  });
});
