import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { corsOrigin } from '../config/cors';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { queryOne } from '../db';
import { DEFAULT_TENANT_ID } from '../config/tenant';
import type { Conversation, JwtPayload, MessageLog } from '../types';

/** Sala (room) do Socket.IO de uma empresa. Eventos só vão para os painéis dela. */
function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

let io: SocketIOServer | null = null;

export const SOCKET_EVENTS = {
  CONVERSATION_UPDATED: 'conversation:updated',
  CONVERSATION_NEW: 'conversation:new',
  MESSAGE_NEW: 'message:new',
  AGENT_STATUS: 'agent:status',
  /**
   * Onboarding WhatsApp (sala tenant:*).
   * Payload: { connectionId, status, detail?, phone?, qrBase64?, phoneCode? }
   * status: PROVISIONING | AGUARDANDO_LEITURA | CONECTANDO | CONECTADO | ERRO | EXPIRADO | DESCONECTADO
   */
  WHATSAPP_STATUS: 'whatsapp:status',
} as const;

export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
  });

  // Autenticação OBRIGATÓRIA via token no handshake.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next(new Error('unauthorized'));
      return;
    }
    try {
      const user = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      if (!user.tenant_id) user.tenant_id = DEFAULT_TENANT_ID;
      socket.data.user = user;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    logger.debug(`Socket conectado: ${socket.id}`);

    // Isolamento por empresa: o painel só recebe eventos do PRÓPRIO tenant.
    const user = socket.data.user as JwtPayload;
    socket.join(tenantRoom(user.tenant_id));

    socket.on('conversation:join', async (conversationId: string) => {
      if (typeof conversationId !== 'string') return;
      // Sempre exige posse: conversa tem que pertencer ao tenant do usuário.
      const owns = await queryOne<{ id: string }>(
        'SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2',
        [conversationId, user.tenant_id],
      ).catch(() => null);
      if (!owns) return;
      socket.join(`conversation:${conversationId}`);
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

export function emitNewMessage(tenantId: string, conversationId: string, message: MessageLog): void {
  if (!io) return;
  // Sala da conversa (quem está com ela aberta) …
  io.to(`conversation:${conversationId}`).emit(SOCKET_EVENTS.MESSAGE_NEW, message);
  // … e a sala do tenant: após reconexão o painel pode ter perdido o join da
  // conversa; o cliente filtra por conversation_id. Assim a bolha aparece sem F5.
  io.to(tenantRoom(tenantId)).emit(SOCKET_EVENTS.MESSAGE_NEW, message);
  io.to(tenantRoom(tenantId)).emit(SOCKET_EVENTS.CONVERSATION_UPDATED, {
    conversationId,
    lastMessage: message,
  });
}

export function emitConversationUpdated(tenantId: string, conversation: Conversation): void {
  if (!io) return;
  io.to(tenantRoom(tenantId)).emit(SOCKET_EVENTS.CONVERSATION_UPDATED, conversation);
}

export function emitNewConversation(tenantId: string, conversation: Conversation): void {
  if (!io) return;
  io.to(tenantRoom(tenantId)).emit(SOCKET_EVENTS.CONVERSATION_NEW, conversation);
}

/** Avisa os painéis DA EMPRESA que o atendente de IA foi ligado/desligado. */
export function emitAgentStatus(tenantId: string, enabled: boolean): void {
  if (!io) return;
  io.to(tenantRoom(tenantId)).emit(SOCKET_EVENTS.AGENT_STATUS, { enabled });
}

export interface WhatsappStatusPayload {
  connectionId: string;
  status: string;
  detail?: string | null;
  phone?: string | null;
  qrBase64?: string | null;
  phoneCode?: string | null;
}

/** Empurra transições do onboarding WhatsApp para a sala do tenant. */
export function emitWhatsappStatus(tenantId: string, payload: WhatsappStatusPayload): void {
  if (!io) return;
  io.to(tenantRoom(tenantId)).emit(SOCKET_EVENTS.WHATSAPP_STATUS, payload);
}
