-- 029: Várias instâncias WhatsApp por empresa + IA por número/conexão.
-- Remove o limite de 1 conexão por tenant. Cada linha em whatsapp_connections
-- é um número/instância independente (Z-API, Evolution ou Meta Cloud), com
-- persona/temperatura/agente próprios (NULL = herda o padrão da empresa).
-- Conversas passam a guardar connection_id para responder pela mesma linha.

-- ============================ whatsapp_connections ============================
DROP INDEX IF EXISTS uq_whatsapp_connections_tenant;

ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS label VARCHAR(120),
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
  ADD COLUMN IF NOT EXISTS ai_persona TEXT,
  ADD COLUMN IF NOT EXISTS ai_temperature NUMERIC(3, 2),
  ADD COLUMN IF NOT EXISTS ai_max_tokens INT,
  ADD COLUMN IF NOT EXISTS agent_enabled BOOLEAN;

-- Nome amigável padrão para conexões já existentes.
UPDATE whatsapp_connections
   SET label = COALESCE(NULLIF(TRIM(label), ''), 'WhatsApp principal')
 WHERE label IS NULL OR TRIM(label) = '';

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_tenant
  ON whatsapp_connections (tenant_id);

-- ============================ conversations.connection_id ============================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_connection
  ON conversations (connection_id);

-- Backfill: conversas abertas da empresa apontam para a conexão mais antiga do tenant.
UPDATE conversations c
   SET connection_id = wc.id
  FROM (
    SELECT DISTINCT ON (tenant_id) id, tenant_id
      FROM whatsapp_connections
     ORDER BY tenant_id, created_at ASC, id ASC
  ) wc
 WHERE c.tenant_id = wc.tenant_id
   AND c.connection_id IS NULL
   AND c.status <> 'closed';

-- Uma conversa aberta por (cliente, conexão). Mantém índice legado para linhas
-- ainda sem connection_id (histórico / race residual).
DROP INDEX IF EXISTS uq_conversations_active_per_client;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_active_per_client_connection
  ON conversations (client_id, connection_id)
  WHERE status <> 'closed' AND connection_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_active_per_client_legacy
  ON conversations (client_id)
  WHERE status <> 'closed' AND connection_id IS NULL;
