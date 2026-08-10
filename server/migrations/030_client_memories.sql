-- 030: Memória de longo prazo do cliente (fatos/eventos pessoais).
-- Append-only; LGPD: is_sensitive + expires_at + delete pela API.

CREATE TABLE IF NOT EXISTS client_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL CHECK (kind IN ('fato', 'evento', 'preferencia', 'sensivel')),
  summary TEXT NOT NULL,
  is_sensitive BOOLEAN NOT NULL DEFAULT false,
  follow_up_at TIMESTAMPTZ,
  source_message_id UUID,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_memories_client
  ON client_memories (tenant_id, client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_memories_expires
  ON client_memories (expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE client_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON client_memories;
CREATE POLICY tenant_isolation ON client_memories
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
