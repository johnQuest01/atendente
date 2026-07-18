import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getToken } from '@/services/api';

const SOCKET_URL = import.meta.env.VITE_API_URL ?? '';

let sharedSocket: Socket | null = null;

function getSocket(): Socket {
  const token = getToken() ?? undefined;
  if (!sharedSocket) {
    sharedSocket = io(SOCKET_URL, {
      autoConnect: Boolean(token),
      auth: { token },
      transports: ['websocket', 'polling'],
    });
  } else {
    sharedSocket.auth = { token };
    if (token && !sharedSocket.connected) sharedSocket.connect();
  }
  return sharedSocket;
}

/**
 * Após login/logout: reautentica o handshake. Desconecta e reconecta com o
 * token atual — evita socket anônimo ou com JWT antigo.
 */
export function reauthSocket(): void {
  const token = getToken() ?? undefined;
  if (!sharedSocket) {
    if (token) getSocket();
    return;
  }
  sharedSocket.auth = { token };
  if (sharedSocket.connected) {
    sharedSocket.disconnect();
  }
  if (token) {
    sharedSocket.connect();
  }
}

/**
 * Assina eventos do Socket.io. O socket é compartilhado entre componentes.
 * `handlers` mapeia nome do evento -> callback.
 */
type SocketHandler = (...args: unknown[]) => void;

export function useSocket(handlers: Record<string, SocketHandler>): Socket {
  const socketRef = useRef(getSocket());
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const socket = socketRef.current;
    // Garante token atual (ex.: página aberta após login em outra aba).
    reauthSocket();
    const entries = Object.keys(handlersRef.current);

    const wrapped: Record<string, SocketHandler> = {};
    for (const event of entries) {
      wrapped[event] = (...args: unknown[]) => handlersRef.current[event]?.(...args);
      socket.on(event, wrapped[event]);
    }

    return () => {
      for (const event of entries) {
        socket.off(event, wrapped[event]);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(handlers).join(',')]);

  return socketRef.current;
}

export function joinConversation(conversationId: string): void {
  getSocket().emit('conversation:join', conversationId);
}

export function leaveConversation(conversationId: string): void {
  getSocket().emit('conversation:leave', conversationId);
}
