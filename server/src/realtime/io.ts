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
import { conversations } from '../db/schema';
import { attachRedisAdapter } from './adapter';
import { env } from '../config/env';
import { ID_RE } from '../contract/common';

/** Match HTTP CORS: missing Origin (non-browser) is allowed; unknown Origin is not. */
export function allowSocketOrigin(origin: string | undefined, host?: string): boolean {
  if (!origin) return true;
  if (env.CORS_ORIGINS.includes(origin)) return true;
  if (host && (origin === `https://${host}` || origin === `http://${host}`)) return true;
  return false;
}

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
};

let io: IOServer | null = null;

export function initRealtime(httpServer: HttpServer, sessionMiddleware: RequestHandler): IOServer {
  const server = new IOServer(httpServer, {
    cors: {
      origin: (origin, cb) => {
        cb(null, allowSocketOrigin(origin));
      },
      credentials: true,
    },
    allowRequest: (req, cb) => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
      cb(null, allowSocketOrigin(origin, host));
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

  server.use((socket, next) => {
    const req = socket.request as SessionedRequest;
    const userId = req.session?.userId;
    if (!userId) {
      next(new Error('unauthenticated'));
      return;
    }
    socket.data.userId = userId;
    next();
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
