/**
 * Socket.io bootstrap.
 *
 * Handshake reuses the Express session cookie — the browser sends `sid`
 * automatically on same-origin WebSocket upgrade. We pipe the session middleware
 * into the engine so `socket.request.session.userId` is populated.
 *
 * Unauthenticated sockets are rejected at connection. Authenticated sockets
 * auto-join a personal room `user:<userId>` for notifications and DMs. Rooms
 * for specific conversations are joined only after a server-side membership
 * check (see handlers below).
 */
import { Server as IOServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../db/client';
import { conversations, users } from '../db/schema';
import { attachRedisAdapter } from './adapter';
import { isAllowedOrigin } from '../lib/origin';
import { ID_RE } from '../contract/common';

/**
 * Zod schemas for inbound socket events. Malformed payloads are dropped
 * quietly (ack: false if an ack is provided). Keeps the attack surface tight
 * without noisy errors for clients that may reconnect with stale state.
 */
const conversationIdSchema = z.object({
  conversationId: z.string().regex(ID_RE, 'Invalid conversationId'),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T | null {
  const result = schema.safeParse(input);
  return result.success ? result.data : null;
}

type SessionedRequest = Parameters<RequestHandler>[0] & {
  session?: { userId?: string };
  sessionID?: string;
};

let io: IOServer | null = null;

export function initRealtime(httpServer: HttpServer, sessionMiddleware: RequestHandler): IOServer {
  const server = new IOServer(httpServer, {
    cors: {
      // The CORS headers only; `allowRequest` below is the gate, and it has
      // the Host the same-host branch needs.
      origin: (origin, cb) => {
        cb(null, isAllowedOrigin(origin, undefined));
      },
      credentials: true,
    },
    allowRequest: (req, cb) => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
      cb(null, isAllowedOrigin(origin, host));
    },
    transports: ['websocket', 'polling'],
  });

  // Multi-instance broadcasts via Redis pub/sub when REDIS_URL is set;
  // logs + stays on the in-memory adapter otherwise (see realtime/adapter.ts).
  void attachRedisAdapter(server);

  // Reuse the same express-session middleware — required so `socket.request.session` is set.
  server.engine.use(
    sessionMiddleware as unknown as (
      req: unknown,
      res: unknown,
      next: (err?: unknown) => void,
    ) => void,
  );

  // The session only says who signed in; whether that account may still hold
  // a live channel is the user row's status, which HTTP re-checks per request
  // (`loadSessionUser`). A suspended or deleted account must not keep
  // receiving DMs and notifications over a socket either.
  server.use((socket, next) => {
    const req = socket.request as SessionedRequest;
    const userId = req.session?.userId;
    if (!userId) {
      next(new Error('unauthenticated'));
      return;
    }
    // `next` is called exactly once, outside the lookup's try: a throw from
    // inside `next()` must not land in the catch and call it a second time.
    (async () => {
      let status: string | undefined;
      try {
        const [user] = await db
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        status = user?.status;
      } catch (err) {
        logger.error({ err }, 'socket handshake user lookup failed');
        next(new Error('unavailable'));
        return;
      }
      if (status !== 'active') {
        next(new Error('unauthenticated'));
        return;
      }
      socket.data.userId = userId;
      // The session this socket rides on: logout ends only that session, so it
      // drops only that session's sockets (`dropSessionSockets`).
      socket.data.sid = req.sessionID;
      next();
    })().catch((err: unknown) => {
      // Only a throw from inside `next()` itself reaches here; logged, never re-sent.
      logger.error({ err }, 'socket handshake middleware threw');
    });
  });

  server.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    socket.join(userRoom(userId));
    logger.debug({ userId, sid: socket.id }, 'socket connected');

    socket.on('conversation:join', async (raw: unknown, ack?: (ok: boolean) => void) => {
      try {
        const parsed = parse(conversationIdSchema, raw);
        if (!parsed) {
          ack?.(false);
          return;
        }
        const allowed = await isConversationMember(parsed.conversationId, userId);
        if (!allowed) {
          ack?.(false);
          return;
        }
        socket.join(conversationRoom(parsed.conversationId));
        ack?.(true);
      } catch (err) {
        logger.error({ err }, 'conversation:join failed');
        ack?.(false);
      }
    });

    socket.on('conversation:leave', (raw: unknown) => {
      const parsed = parse(conversationIdSchema, raw);
      if (parsed) socket.leave(conversationRoom(parsed.conversationId));
    });

    // Typing indicators. `socket.to(room)` does not require the sender to be
    // in the room, so we refuse unless they joined via conversation:join.
    socket.on('typing', (raw: unknown) => {
      const parsed = parse(conversationIdSchema, raw);
      if (!parsed) return;
      const room = conversationRoom(parsed.conversationId);
      if (!socket.rooms.has(room)) return;
      socket.to(room).emit('typing', { userId });
    });

    socket.on('typing:end', (raw: unknown) => {
      const parsed = parse(conversationIdSchema, raw);
      if (!parsed) return;
      const room = conversationRoom(parsed.conversationId);
      if (!socket.rooms.has(room)) return;
      socket.to(room).emit('typing:end', { userId });
    });

    socket.on('disconnect', () => {
      logger.debug({ userId, sid: socket.id }, 'socket disconnected');
    });
  });

  io = server;
  return server;
}

export function getIO(): IOServer | null {
  return io;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/**
 * Disconnect the sockets a just-ended session opened. Logout on one device
 * must not cut realtime on the others: those are other sessions, still valid.
 * `fetchSockets` goes through the adapter, so this also reaches sockets held by
 * another instance under the Redis adapter. Best-effort: a failed lookup is
 * logged, never fails the logout that called it.
 */
export async function dropSessionSockets(
  userId: string | undefined,
  sid: string | undefined,
): Promise<void> {
  if (!io || !userId || !sid) return;
  try {
    const sockets = await io.in(userRoom(userId)).fetchSockets();
    for (const socket of sockets) {
      if (socket.data.sid === sid) socket.disconnect(true);
    }
  } catch (err) {
    logger.warn({ err }, 'dropSessionSockets failed');
  }
}

/** Disconnect every socket of a user — a password change ends all their sessions. */
export function dropUserSockets(userId: string): void {
  io?.in(userRoom(userId)).disconnectSockets(true);
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  if (!io) return;
  io.to(userRoom(userId)).emit(event, payload);
}

export function emitToConversation(conversationId: string, event: string, payload: unknown): void {
  if (!io) return;
  io.to(conversationRoom(conversationId)).emit(event, payload);
}

async function isConversationMember(conversationId: string, userId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        sql`${conversations.participantIds} @> ARRAY[${userId}]::text[]`,
      ),
    )
    .limit(1);
  return Boolean(hit);
}
