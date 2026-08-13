-- 049: Aviso ao dono quando um contato mandar mensagem.
-- "Me avisa quando o Wender mandar mensagem" → secretário toca o dono no zap.

CREATE TABLE IF NOT EXISTS contact_message_watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  owner_phone TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'once'
    CHECK (mode IN ('once', 'always')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'fired', 'cancelled')),
  last_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_watches_active_unique
  ON contact_message_watches (
    tenant_id,
    owner_phone,
    client_id,
    COALESCE(connection_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_contact_watches_inbound
  ON contact_message_watches (tenant_id, client_id, status)
  WHERE status = 'active';

COMMENT ON TABLE contact_message_watches IS
  'Pedido do dono: avisar quando este contato mandar mensagem neste WhatsApp.';

ALTER TABLE contact_message_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_message_watches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contact_message_watches;
CREATE POLICY tenant_isolation ON contact_message_watches
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
