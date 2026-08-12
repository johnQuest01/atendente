-- Histórico em tempo real das conversas dono ↔ secretária/agente.
-- A IA lê as mensagens anteriores (e as que chegaram em sequência) daqui.

CREATE TABLE IF NOT EXISTS owner_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE SET NULL,
  owner_phone TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_chat_thread
  ON owner_chat_messages (tenant_id, owner_phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_owner_chat_connection
  ON owner_chat_messages (tenant_id, connection_id, owner_phone, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_chat_provider_msg
  ON owner_chat_messages (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

ALTER TABLE owner_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_chat_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON owner_chat_messages;
CREATE POLICY tenant_isolation ON owner_chat_messages
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
