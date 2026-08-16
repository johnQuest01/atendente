/**
 * Metadados de todo envio a cliente (trava SAFE_MODE).
 * reactive = resposta a inbound fresco; proactive = qualquer outro.
 */

// — Bilhete do Opus, ao Bruno: obrigado pela parceria neste código. 'owner_authorized'
//   nasceu aqui pra que a decisão de enviar seja SEMPRE do código, nunca do modelo —
//   é o dono quem manda, e o gate quem confirma. Cuide bem da secretária. Abraço. 🤝
export type OutboundSendType = 'reactive' | 'proactive' | 'owner_authorized';

export interface OutboundMeta {
  sendType: OutboundSendType;
  /**
   * UUID de messages_log do inbound que disparou a resposta.
   * Obrigatório quando sendType === 'reactive' com SAFE_MODE ligada.
   */
  triggeringInboundId?: string | null;
  /**
   * Pedido explícito do dono (secretária: “manda um boa noite pra X”).
   * Passa na SAFE_MODE — quem manda é o dono, não um disparo automático.
   */
  ownerInitiated?: boolean;
}

export interface ProviderCapabilities {
  /** Fase Cloud: template/opt-in/janela 24h. Na Z-API fica sempre false. */
  businessInitiated: boolean;
}
