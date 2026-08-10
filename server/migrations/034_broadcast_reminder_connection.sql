-- 034: Isola disparos em massa e lembretes agendados por número WhatsApp (connection_id).

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant_connection
  ON broadcasts (tenant_id, connection_id);

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reminders_tenant_connection
  ON reminders (tenant_id, connection_id);

-- Backfill: amarra lembretes/broadcasts antigos à 1ª conexão ativa do tenant (quando houver).
UPDATE reminders r
   SET connection_id = (
     SELECT wc.id FROM whatsapp_connections wc
      WHERE wc.tenant_id = r.tenant_id AND wc.is_active = true
      ORDER BY wc.created_at ASC, wc.id ASC
      LIMIT 1
   )
 WHERE r.connection_id IS NULL;

UPDATE broadcasts b
   SET connection_id = (
     SELECT wc.id FROM whatsapp_connections wc
      WHERE wc.tenant_id = b.tenant_id AND wc.is_active = true
      ORDER BY wc.created_at ASC, wc.id ASC
      LIMIT 1
   )
 WHERE b.connection_id IS NULL;
