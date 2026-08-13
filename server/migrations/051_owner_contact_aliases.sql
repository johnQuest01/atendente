-- 051: Apelido estável do dono → contato.
-- "Wender" deixa de perguntar de novo depois que o dono já escolheu qual.

CREATE TABLE IF NOT EXISTS owner_contact_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  owner_phone TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_contact_aliases_unique
  ON owner_contact_aliases (
    tenant_id,
    owner_phone,
    alias_key,
    COALESCE(connection_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_owner_contact_aliases_lookup
  ON owner_contact_aliases (tenant_id, owner_phone, alias_key);

COMMENT ON TABLE owner_contact_aliases IS
  'Qual contato o dono quis dizer com um nome (ex.: Wender = este telefone).';

ALTER TABLE owner_contact_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_contact_aliases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON owner_contact_aliases;
CREATE POLICY tenant_isolation ON owner_contact_aliases
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
