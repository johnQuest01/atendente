/**
 * Metadados de todo envio a cliente (trava SAFE_MODE).
 * reactive = resposta a inbound fresco; proactive = qualquer outro.
 */

export type OutboundSendType = 'reactive' | 'proactive';

export interface OutboundMeta {
  sendType: OutboundSendType;
  /**
   * UUID de messages_log do inbound que disparou a resposta.
   * Obrigatório quando sendType === 'reactive' com SAFE_MODE ligada.
   */
  triggeringInboundId?: string | null;
}

export interface ProviderCapabilities {
  /** Fase Cloud: template/opt-in/janela 24h. Na Z-API fica sempre false. */
  businessInitiated: boolean;
}
