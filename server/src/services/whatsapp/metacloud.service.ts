import { logger } from '../../config/logger';
import { NotImplementedError, type ProviderStatus, type WhatsAppProvider } from './types';

/**
 * Esqueleto do provedor Meta Cloud API (WhatsApp oficial).
 * Autenticação: Bearer token + phone_number_id.
 * Endpoints Graph: https://graph.facebook.com/v21.0/{phone_number_id}/messages
 *
 * Métodos de envio/parse lançam NotImplementedError até a implementação real.
 * getConnectionStatus NÃO espelha “celular pareado” (Z-API) — a Cloud API é
 * gerenciada pela Meta; reportamos disponibilidade da configuração.
 */

export interface MetaCloudConnection {
  accessToken: string;
  phoneNumberId: string;
  /** Ex.: https://graph.facebook.com/v21.0 */
  graphBaseUrl?: string;
  /** Verify token do webhook Meta (opcional nesta fase). */
  verifyToken?: string;
}

const DEFAULT_GRAPH = 'https://graph.facebook.com/v21.0';

export function messagesUrl(conn: MetaCloudConnection): string {
  const base = (conn.graphBaseUrl || DEFAULT_GRAPH).replace(/\/+$/, '');
  return `${base}/${conn.phoneNumberId}/messages`;
}

export function createMetaCloudProvider(conn: MetaCloudConnection): WhatsAppProvider {
  const configured = Boolean(conn.accessToken && conn.phoneNumberId);

  return {
    async sendText() {
      logger.warn('MetaCloud.sendText chamado — não implementado.');
      throw new NotImplementedError('sendText');
    },
    async sendAudio() {
      throw new NotImplementedError('sendAudio');
    },
    async sendImage() {
      throw new NotImplementedError('sendImage');
    },
    async sendImages() {
      throw new NotImplementedError('sendImages');
    },
    async markAsRead() {
      throw new NotImplementedError('markAsRead');
    },
    async getConnectionStatus(): Promise<ProviderStatus> {
      if (!configured) {
        return {
          ok: false,
          detail: 'Meta Cloud não configurada (accessToken / phoneNumberId ausentes).',
        };
      }
      // A Cloud API não expõe “smartphoneConnected” como a Z-API.
      return {
        ok: true,
        detail: 'Meta Cloud configurada (status de pareamento N/A — gerenciado pela Meta).',
      };
    },
  };
}

/** Headers padrão Graph API. */
export function metaAuthHeaders(conn: MetaCloudConnection): Record<string, string> {
  return {
    Authorization: `Bearer ${conn.accessToken}`,
    'Content-Type': 'application/json',
  };
}
