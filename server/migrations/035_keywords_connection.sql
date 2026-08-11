-- 035: Isola palavras-chave (incl. disparo de agenda) por número WhatsApp.
-- NULL em connection_id = vale para todas as instâncias (legado / keywords comerciais).

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_keywords_tenant_connection
  ON keywords (tenant_id, connection_id);

-- Backfill: amarra keywords antigas à 1ª conexão ativa do tenant (quando houver).
UPDATE keywords k
   SET connection_id = (
     SELECT wc.id FROM whatsapp_connections wc
      WHERE wc.tenant_id = k.tenant_id AND wc.is_active = true
      ORDER BY wc.created_at ASC, wc.id ASC
      LIMIT 1
   )
 WHERE k.connection_id IS NULL;
