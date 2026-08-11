-- Alavancas Secretária + Agente (por conexão WhatsApp).
-- Secretária: criar/consultar lembretes com números autorizados (default LIGADA).
-- Agente: chat livre estilo Claude + busca web opcional (default DESLIGADA / opt-in).

ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS owner_secretary_enabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS owner_free_chat_enabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS owner_web_search_enabled BOOLEAN;

COMMENT ON COLUMN whatsapp_connections.owner_secretary_enabled IS
  'NULL/true = secretária de lembretes ligada; false = desliga criar/consultar agenda neste número.';
COMMENT ON COLUMN whatsapp_connections.owner_free_chat_enabled IS
  'NULL/false = off; true = modo Agente (chat livre do dono).';
COMMENT ON COLUMN whatsapp_connections.owner_web_search_enabled IS
  'NULL/false = off; true = busca na web no modo Agente (requer free chat).';
