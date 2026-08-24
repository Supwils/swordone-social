/**
 * Socket-level integration tests for initRealtime — a real socket.io server on
 * an ephemeral port, real socket.io-client connections, and the real Postgres
 * membership check behind conversation:join.
 *
 * The session middleware is faked: it reads `x-test-user` from the handshake
 * headers instead of decoding an express-session cookie. That keeps the auth
 * *gate* under test (no header -> no session -> rejected) without dragging the
 * whole session store into the suite — the cookie decode itself is
 * express-session's contract, not ours.
 *
 * The Redis adapter is mocked out: a developer's local .env may carry a live
 * REDIS_URL, and whether the pub/sub adapter attaches mid-suite must not
 * change how rooms behave here. adapter.ts has its own dedicated tests.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { Server as IOServer } from 'socket.io';
import { db } from '../db/client';
import { users, conversations } from '../db/schema';
import { resetDb } from '../test/db-reset';
import type { ConversationRow, UserRow } from '../lib/dto';
import {
  conversationRoom,
  emitToConversation,
  emitToUser,
  getIO,
  initRealtime,
  userRoom,
} from './io';

vi.mock('./adapter', () => ({
  attachRedisAdapter: async () => false,
  closeRedisAdapter: async () => undefined,
}));

let seq = 0;
async function seedUser(): Promise<UserRow> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `sock${seq}`,
      usernameDisplay: `sock${seq}`,
      email: `sock${seq}@example.com`,
      displayName: `Sock ${seq}`,
    })
    .returning();
  return u;
}

async function seedConversation(participantIds: string[]): Promise<ConversationRow> {
  seq += 1;
  const [c] = await db
    .insert(conversations)
    .values({ participantIds, participantKey: `sock-key-${seq}` })
    .returning();
  return c;
}

type SessionCarrier = { session?: { userId?: string } };

/** Stand-in for the express-session middleware: header -> session.userId. */
const fakeSession: RequestHandler = (req, _res, next) => {
  const header = req.headers['x-test-user'];
  if (typeof header === 'string' && header.length > 0) {
    (req as unknown as SessionCarrier).session = { userId: header };
  }
  next();
};

describe('realtime socket server', () => {
  let httpServer: HttpServer;
  let ioServer: IOServer;
  let base = '';
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    httpServer = createServer();
    ioServer = initRealtime(httpServer, fakeSession);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await ioServer.close().catch(() => undefined);
  });

  beforeEach(resetDb);

  afterEach(() => {
    for (const socket of clients.splice(0)) socket.disconnect();
  });

  function connect(userId?: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioc(base, {
        transports: ['websocket'],
        reconnection: false,
        timeout: 3000,
        extraHeaders: userId ? { 'x-test-user': userId } : undefined,
      });
      clients.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', (err: Error) => reject(err));
    });
  }

  function joinConversation(socket: ClientSocket, conversationId: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      socket.emit('conversation:join', { conversationId }, (ok: boolean) => resolve(ok));
    });
  }

  function nextEvent<T>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, resolve));
  }

  /** Server-side truth: is this socket currently in this room? */
  function inRoom(socketId: string, room: string): boolean {
    return ioServer.sockets.adapter.rooms.get(room)?.has(socketId) ?? false;
  }

  it('rejects a connection with no session userId', async () => {
    await expect(connect()).rejects.toThrow('unauthenticated');
  });

  it('auto-joins the personal user room and receives emitToUser events', async () => {
    const u1 = await seedUser();
    const socket = await connect(u1.id);

    expect(getIO()).toBe(ioServer);
    expect(inRoom(socket.id as string, userRoom(u1.id))).toBe(true);

    const received = nextEvent(socket, 'notification:new');
    emitToUser(u1.id, 'notification:new', { kind: 'like' });
    expect(await received).toEqual({ kind: 'like' });
  });

  it('conversation:join acks true for a member — with a real generated id', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    // The id comes from newId() via the column default: this pins the
    // conversationIdSchema regex to the real id format. If either drifts,
    // every real join in production would start acking false.
    const convo = await seedConversation([u1.id, u2.id]);
    const socket = await connect(u1.id);

    await expect(joinConversation(socket, convo.id)).resolves.toBe(true);
    expect(inRoom(socket.id as string, conversationRoom(convo.id))).toBe(true);

    const received = nextEvent(socket, 'message:new');
    emitToConversation(convo.id, 'message:new', { body: 'hi' });
    expect(await received).toEqual({ body: 'hi' });
  });

  it('conversation:join acks false for a non-member and does not join the room', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const u3 = await seedUser();
    const convo = await seedConversation([u2.id, u3.id]);
    const socket = await connect(u1.id);

    await expect(joinConversation(socket, convo.id)).resolves.toBe(false);
    expect(inRoom(socket.id as string, conversationRoom(convo.id))).toBe(false);
  });

  it('conversation:join acks false on malformed payloads', async () => {
    const u1 = await seedUser();
    const socket = await connect(u1.id);

    await expect(joinConversation(socket, 'not-a-hex-id')).resolves.toBe(false);
    await expect(joinConversation(socket, 12345)).resolves.toBe(false);
    await expect(
      new Promise((resolve) => socket.emit('conversation:join', null, resolve)),
    ).resolves.toBe(false);
  });

  it('conversation:leave removes the socket from the room', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const convo = await seedConversation([u1.id, u2.id]);
    const socket = await connect(u1.id);
    await joinConversation(socket, convo.id);
    expect(inRoom(socket.id as string, conversationRoom(convo.id))).toBe(true);

    socket.emit('conversation:leave', { conversationId: convo.id });

    await expect
      .poll(() => inRoom(socket.id as string, conversationRoom(convo.id)))
      .toBe(false);
  });

  it('drops typing from a socket that never joined the room', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const convo = await seedConversation([u1.id, u2.id]);
    const sender = await connect(u1.id);
    const listener = await connect(u2.id);
    await joinConversation(listener, convo.id);

    const typingEvents: unknown[] = [];
    listener.on('typing', (p: unknown) => typingEvents.push(p));

    // sender is a member but has NOT joined the room — typing must be dropped.
    sender.emit('typing', { conversationId: convo.id });
    // Sequencing: the join ack proves the server processed the typing packet
    // (per-socket packets are handled in order); the sentinel proves the
    // listener's delivery stream is flushed past any typing forward.
    await joinConversation(sender, convo.id);
    const sentinel = nextEvent(listener, 'sentinel');
    emitToConversation(convo.id, 'sentinel', {});
    await sentinel;

    expect(typingEvents).toEqual([]);
  });

  it('forwards typing and typing:end to other members but never echoes the sender', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const convo = await seedConversation([u1.id, u2.id]);
    const sender = await connect(u1.id);
    const listener = await connect(u2.id);
    await joinConversation(sender, convo.id);
    await joinConversation(listener, convo.id);

    const senderEcho: unknown[] = [];
    sender.on('typing', (p: unknown) => senderEcho.push(p));
    sender.on('typing:end', (p: unknown) => senderEcho.push(p));

    const typing = nextEvent(listener, 'typing');
    sender.emit('typing', { conversationId: convo.id });
    expect(await typing).toEqual({ userId: u1.id });

    const typingEnd = nextEvent(listener, 'typing:end');
    sender.emit('typing:end', { conversationId: convo.id });
    expect(await typingEnd).toEqual({ userId: u1.id });

    // The listener has received both events, so the server long since
    // processed them — anything echoed to the sender would already be here.
    expect(senderEcho).toEqual([]);
  });

  it('drops typing with a malformed conversationId without disconnecting', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const convo = await seedConversation([u1.id, u2.id]);
    const sender = await connect(u1.id);
    const listener = await connect(u2.id);
    await joinConversation(sender, convo.id);
    await joinConversation(listener, convo.id);

    sender.emit('typing', { conversationId: 'zz' });
    // The socket survives and a well-formed typing still flows.
    const typing = nextEvent(listener, 'typing');
    sender.emit('typing', { conversationId: convo.id });
    expect(await typing).toEqual({ userId: u1.id });
    expect(sender.connected).toBe(true);
  });
});
