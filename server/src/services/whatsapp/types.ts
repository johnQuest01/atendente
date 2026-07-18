import type { MessageType } from '../../types';

/** Status de conexão do provedor (pareamento do celular, etc.). */
export interface ProviderStatus {
  ok: boolean;
  detail: string;
}

/**
 * Formato neutro de mensagem inbound — único contrato do webhook/pipeline.
 * Preenchido por cada provider a partir do payload cru.
 */
export interface NormalizedInbound {
  phone: string;
  text: string;
  type: MessageType;
  /** ID da mensagem no provedor (Z-API / Evolution / Meta). */
  providerMessageId: string | null;
  senderName: string | null;
  fromMe: boolean;
  mediaUrl?: string | null;
  mediaBase64?: string | null;
  mediaMime?: string | null;
  fileName?: string | null;
  caption?: string | null;
  timestamp?: string | null;
  /** Payload original (debug / futuros parsers). */
  raw?: Record<string, unknown>;
}

export interface NormalizedStatus {
  ids: string[];
  status: 'READ' | 'DELIVERED';
}

/**
 * Contrato de envio/status por conexão de WhatsApp.
 * Derivado do que o sistema já usa hoje (TenantWhatsapp).
 */
export interface WhatsAppProvider {
  sendText(phone: string, message: string): Promise<string | null>;
  sendAudio(phone: string, audioUrl: string): Promise<string | null>;
  sendImage(phone: string, imageUrl: string, caption?: string): Promise<string | null>;
  sendImages(phone: string, imageUrls: string[], caption?: string): Promise<Array<string | null>>;
  markAsRead(phone: string, messageId: string): Promise<string | null>;
  getConnectionStatus(): Promise<ProviderStatus>;
}

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`Meta Cloud API: ${method} ainda não implementado.`);
    this.name = 'NotImplementedError';
  }
}
