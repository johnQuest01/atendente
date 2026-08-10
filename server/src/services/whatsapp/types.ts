import type { MessageType } from '../../types';

/** Status de conexão do provedor (pareamento do celular, etc.). */
export interface ProviderStatus {
  ok: boolean;
  detail: string;
  /** Número E.164 detectado no provedor (quando disponível). */
  phone?: string | null;
}

/**
 * Formato neutro de mensagem inbound — único contrato do webhook/pipeline.
 * Preenchido por cada provider a partir do payload cru.
 */
export interface NormalizedInbound {
  phone: string;
  /**
   * WhatsApp @lid (só dígitos). Quando a Z-API manda fromMe, muitas vezes
   * `phone` É o lid — aí `phoneIsLid` fica true e o pipeline resolve o cliente
   * pelo lid cadastrado no contato real.
   */
  lid: string | null;
  /** true quando `phone` não é um número E.164 utilizável, e sim um LID. */
  phoneIsLid: boolean;
  text: string;
  type: MessageType;
  /** ID da mensagem no provedor (Z-API / Evolution / Meta). */
  providerMessageId: string | null;
  senderName: string | null;
  fromMe: boolean;
  mediaUrl?: string | null;
  mediaBase64?: string | null;
  mediaMime?: string | null;
  /**
   * Handle da mídia no provedor, quando ele não entrega URL nem base64 no
   * webhook (caso da Meta Cloud). Resolvido depois via `downloadMedia`.
   */
  mediaId?: string | null;
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
  /**
   * Só para provedores que entregam a mídia por handle (Meta Cloud). Baixa os
   * bytes autenticado e devolve base64, o mesmo formato que a Evolution já
   * manda pronto no webhook.
   */
  downloadMedia?(mediaId: string): Promise<DownloadedMedia | null>;
  /**
   * Registra a URL de webhook no provedor, quando ele permite fazer isso por
   * API. Ausente = a configuração é manual no painel dele (caso da Meta, onde
   * a URL é validada por um desafio).
   */
  configureWebhook?(url: string): Promise<ProviderStatus>;
  /** Apaga no WhatsApp (para todos, salvo deleteForMe). */
  deleteMessage?(
    phone: string,
    messageId: string,
    owner: boolean,
    deleteForMe?: boolean,
  ): Promise<{ ok: boolean; detail: string }>;
  /** Corrige texto já enviado (quando o provedor suporta). */
  editText?(phone: string, messageId: string, message: string): Promise<string | null>;
}

export interface DownloadedMedia {
  base64: string;
  mime: string | null;
  fileName?: string | null;
}
