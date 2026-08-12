-- Modo Agente do dono (chat livre + busca web), por conexão WhatsApp.
-- Secretária (lembretes) continua sempre disponível via gatilhos de agenda.
-- Default: desligado (opt-in por custo de token).

ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS owner_free_chat_enabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS owner_web_search_enabled BOOLEAN;

COMMENT ON COLUMN whatsapp_connections.owner_free_chat_enabled IS
  'NULL = herda settings do tenant; true/false = chat livre do dono (modo Agente).';
COMMENT ON COLUMN whatsapp_connections.owner_web_search_enabled IS
  'NULL = herda settings do tenant; true/false = busca na web no modo Agente.';
