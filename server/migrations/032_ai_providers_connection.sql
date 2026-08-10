-- 032: Liga cada provedor/modelo de IA a uma instância WhatsApp (ou a todas).
-- NULL em connection_id = atende TODAS as instâncias da empresa.
-- Credenciais continuam únicas no cadastro; só o vínculo muda.

ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_providers_connection
  ON ai_providers (tenant_id, connection_id);
