import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getToken } from '@/services/api';

const SOCKET_URL = import.meta.env.VITE_API_URL ?? '';

let sharedSocket: Socket | null = null;

function getSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = io(SOCKET_URL, {
      autoConnect: true,
      auth: { token: getToken() ?? undefined },
      transports: ['websocket', 'polling'],
    });
  }
  return sharedSocket;
}

/**
 * Assina eventos do Socket.io. O socket é compartilhado entre componentes.
 * `handlers` mapeia nome do evento -> callback.
 */
type SocketHandler = (...args: unknown[]) => void;

export function useSocket(handlers: Record<string, SocketHandler>): Socket {
  const socketRef = useRef<Socket>(getSocket());
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const socket = socketRef.current;
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
