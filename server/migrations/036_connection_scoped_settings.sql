-- 036: Config por conexão (persona, behavior, lembretes, memory-scan, owners).
-- keywords já têm connection_id (035); ai_providers (032); overrides de IA
-- em whatsapp_connections (029). Aqui: settings por instância + owners.

-- ---------------------------------------------------------------------------
-- 1) Colunas extras na própria conexão (persona de lembretes + varredura)
-- ---------------------------------------------------------------------------
ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS reminder_assistant_persona TEXT,
  ADD COLUMN IF NOT EXISTS memory_scan_enabled BOOLEAN;

-- ---------------------------------------------------------------------------
-- 2) Settings key-value por conexão (behavior / ajustes finos)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connection_settings (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, connection_id, key)
);

CREATE INDEX IF NOT EXISTS idx_connection_settings_connection
  ON connection_settings (tenant_id, connection_id);

DO $$
BEGIN
  ALTER TABLE connection_settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE connection_settings FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON connection_settings;
  CREATE POLICY tenant_isolation ON connection_settings
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
END $$;

-- ---------------------------------------------------------------------------
-- 3) Reminder owners por conexão
-- ---------------------------------------------------------------------------
ALTER TABLE reminder_owners
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE CASCADE;

-- Backfill owners → 1ª conexão ativa do tenant
UPDATE reminder_owners ro
   SET connection_id = (
     SELECT wc.id FROM whatsapp_connections wc
      WHERE wc.tenant_id = ro.tenant_id AND wc.is_active = true
      ORDER BY wc.created_at ASC, wc.id ASC
      LIMIT 1
   )
 WHERE ro.connection_id IS NULL;

-- Remove owners órfãos (tenant sem nenhuma conexão) — sem onde amarrar.
DELETE FROM reminder_owners WHERE connection_id IS NULL;

ALTER TABLE reminder_owners
  DROP CONSTRAINT IF EXISTS reminder_owners_pkey;

ALTER TABLE reminder_owners
  ALTER COLUMN connection_id SET NOT NULL;

ALTER TABLE reminder_owners
  ADD PRIMARY KEY (tenant_id, phone, connection_id);

CREATE INDEX IF NOT EXISTS idx_reminder_owners_connection
  ON reminder_owners (tenant_id, connection_id);

-- ---------------------------------------------------------------------------
-- 4) Backfill: copia settings do tenant → cada conexão (só onde ainda NULL)
-- ---------------------------------------------------------------------------

-- Persona / temp / tokens / agent (colunas 029)
UPDATE whatsapp_connections wc
   SET ai_persona = COALESCE(
         NULLIF(TRIM(wc.ai_persona), ''),
         (SELECT NULLIF(TRIM(s.value), '') FROM settings s
           WHERE s.tenant_id = wc.tenant_id AND s.key = 'ai_persona')
       ),
       ai_temperature = COALESCE(
         wc.ai_temperature,
         (SELECT NULLIF(TRIM(s.value), '')::numeric FROM settings s
           WHERE s.tenant_id = wc.tenant_id AND s.key = 'ai_temperature'
             AND s.value ~ '^[0-9]+(\\.[0-9]+)?$')
       ),
       ai_max_tokens = COALESCE(
         wc.ai_max_tokens,
         (SELECT NULLIF(TRIM(s.value), '')::int FROM settings s
           WHERE s.tenant_id = wc.tenant_id AND s.key = 'ai_max_tokens'
             AND s.value ~ '^[0-9]+$')
       ),
       agent_enabled = COALESCE(
         wc.agent_enabled,
         CASE
           WHEN (SELECT s.value FROM settings s
                  WHERE s.tenant_id = wc.tenant_id AND s.key = 'agent_enabled') = 'false'
             THEN false
           WHEN (SELECT s.value FROM settings s
                  WHERE s.tenant_id = wc.tenant_id AND s.key = 'agent_enabled') = 'true'
             THEN true
           ELSE NULL
         END
       ),
       reminder_assistant_persona = COALESCE(
         NULLIF(TRIM(wc.reminder_assistant_persona), ''),
         (SELECT NULLIF(TRIM(s.value), '') FROM settings s
           WHERE s.tenant_id = wc.tenant_id AND s.key = 'reminder_assistant_persona')
       ),
       memory_scan_enabled = COALESCE(
         wc.memory_scan_enabled,
         CASE
           WHEN (SELECT s.value FROM settings s
                  WHERE s.tenant_id = wc.tenant_id AND s.key = 'memory_scan_enabled') = 'true'
             THEN true
           WHEN (SELECT s.value FROM settings s
                  WHERE s.tenant_id = wc.tenant_id AND s.key = 'memory_scan_enabled') = 'false'
             THEN false
           ELSE NULL
         END
       );

-- Behavior keys → connection_settings (por conexão)
INSERT INTO connection_settings (tenant_id, connection_id, key, value)
SELECT wc.tenant_id, wc.id, s.key, s.value
  FROM whatsapp_connections wc
  JOIN settings s ON s.tenant_id = wc.tenant_id
 WHERE s.key IN ('ai_temperature', 'ai_max_tokens', 'reminder_assistant_tone')
ON CONFLICT (tenant_id, connection_id, key) DO NOTHING;
