import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { logger } from '../config/logger';
import type { Conversation, JwtPayload, MessageLog } from '../types';

let io: SocketIOServer | null = null;

export const SOCKET_EVENTS = {
  CONVERSATION_UPDATED: 'conversation:updated',
  CONVERSATION_NEW: 'conversation:new',
  MESSAGE_NEW: 'message:new',
  AGENT_STATUS: 'agent:status',
} as const;

export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: env.FRONTEND_URL, credentials: true },
  });

  // Autenticação opcional via token no handshake.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next();
      return;
    }
    try {
      socket.data.user = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    logger.debug(`Socket conectado: ${socket.id}`);

    socket.on('conversation:join', (conversationId: string) => {
      if (typeof conversationId === 'string') socket.join(`conversation:${conversationId}`);
    });
    socket.on('conversation:leave', (conversationId: string) => {
      if (typeof conversationId === 'string') socket.leave(`conversation:${conversationId}`);
    });
    socket.on('disconnect', () => logger.debug(`Socket desconectado: ${socket.id}`));
  });

  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

export function emitNewMessage(conversationId: string, message: MessageLog): void {
  if (!io) return;
  io.to(`conversation:${conversationId}`).emit(SOCKET_EVENTS.MESSAGE_NEW, message);
  io.emit(SOCKET_EVENTS.CONVERSATION_UPDATED, { conversationId, lastMessage: message });
}

export function emitConversationUpdated(conversation: Conversation): void {
  if (!io) return;
  io.emit(SOCKET_EVENTS.CONVERSATION_UPDATED, conversation);
}

export function emitNewConversation(conversation: Conversation): void {
  if (!io) return;
  io.emit(SOCKET_EVENTS.CONVERSATION_NEW, conversation);
}

/** Avisa todos os painéis que o atendente de IA foi ligado/desligado. */
export function emitAgentStatus(enabled: boolean): void {
  if (!io) return;
  io.emit(SOCKET_EVENTS.AGENT_STATUS, { enabled });
}
