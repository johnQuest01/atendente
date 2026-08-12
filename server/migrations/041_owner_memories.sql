-- Memória de longo prazo do dono (eventos, acontecimentos, fatos).
-- Complementa owner_chat_messages: o chat é o fio; isto é o caderno durável.

CREATE TABLE IF NOT EXISTS owner_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE SET NULL,
  owner_phone TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fato', 'evento', 'acontecimento', 'preferencia', 'acao')),
  summary TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_memories_phone
  ON owner_memories (tenant_id, owner_phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_owner_memories_kind
  ON owner_memories (tenant_id, owner_phone, kind, created_at DESC);

ALTER TABLE owner_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON owner_memories;
CREATE POLICY tenant_isolation ON owner_memories
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
