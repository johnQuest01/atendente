-- 037: Onboarding embutido Z-API (pool de trial + metadados por conexão).

-- ---------------------------------------------------------------------------
-- 1) Status de conta do tenant (trial 7d vs ativo vs expirado)
-- ---------------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'trial'
    CHECK (account_status IN ('trial', 'active', 'expired'));

-- Backfill: sem trial_ends_at = active (ex.: empresa padrão); vencido = expired; senão trial.
UPDATE tenants
   SET account_status = CASE
     WHEN trial_ends_at IS NULL THEN 'active'
     WHEN trial_ends_at <= NOW() THEN 'expired'
     ELSE 'trial'
   END
 WHERE TRUE;

-- ---------------------------------------------------------------------------
-- 2) Metadados de onboarding na conexão WhatsApp
-- ---------------------------------------------------------------------------
ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS provider_mode VARCHAR(20) NOT NULL DEFAULT 'web'
    CHECK (provider_mode IN ('web', 'phoneless')),
  ADD COLUMN IF NOT EXISTS instance_origin VARCHAR(20) NOT NULL DEFAULT 'manual'
    CHECK (instance_origin IN ('on_demand', 'pool', 'manual')),
  ADD COLUMN IF NOT EXISTS connection_status VARCHAR(40) NOT NULL DEFAULT 'DESCONECTADO'
    CHECK (connection_status IN (
      'PROVISIONING', 'AGUARDANDO_LEITURA', 'CONECTANDO', 'CONECTADO',
      'ERRO', 'EXPIRADO', 'DESCONECTADO'
    )),
  ADD COLUMN IF NOT EXISTS webhook_configured BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zapi_subscribed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pool_instance_id UUID,
  ADD COLUMN IF NOT EXISTS onboarding_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_status
  ON whatsapp_connections (tenant_id, connection_status);

-- ---------------------------------------------------------------------------
-- 3) Pool de instâncias pagas (trials de 7 dias do cliente)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instance_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Credenciais cifradas (AES-256-GCM), mesmo utilitário do restante do app.
  secrets_encrypted TEXT NOT NULL,
  provider_mode VARCHAR(20) NOT NULL DEFAULT 'web'
    CHECK (provider_mode IN ('web', 'phoneless')),
  state VARCHAR(20) NOT NULL DEFAULT 'free'
    CHECK (state IN ('free', 'in_use')),
  assigned_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  assigned_connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE SET NULL,
  label VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instance_pool_state ON instance_pool (state);

-- Pool é recurso de plataforma (sem tenant_id próprio): RLS permissiva quando
-- app.tenant_id vazio (jobs/admin); bloqueia leitura cruzada de tenants.
ALTER TABLE instance_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_pool FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON instance_pool;
CREATE POLICY tenant_isolation ON instance_pool
USING (
  coalesce(current_setting('app.tenant_id', true), '') = ''
  OR assigned_tenant_id::text = current_setting('app.tenant_id', true)
)
WITH CHECK (
  coalesce(current_setting('app.tenant_id', true), '') = ''
  OR assigned_tenant_id::text = current_setting('app.tenant_id', true)
);

ALTER TABLE whatsapp_connections
  DROP CONSTRAINT IF EXISTS whatsapp_connections_pool_instance_id_fkey;
ALTER TABLE whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_pool_instance_id_fkey
  FOREIGN KEY (pool_instance_id) REFERENCES instance_pool(id) ON DELETE SET NULL;
