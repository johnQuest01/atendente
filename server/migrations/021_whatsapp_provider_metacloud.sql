-- 021: aceita provider 'metacloud' em whatsapp_connections (esqueleto Meta Cloud API).
-- Idempotente: recria o CHECK incluindo o novo valor.

ALTER TABLE whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_provider_check;

ALTER TABLE whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_provider_check
  CHECK (provider IN ('zapi', 'evolution', 'metacloud'));
