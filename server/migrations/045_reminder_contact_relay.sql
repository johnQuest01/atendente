-- 045: Lembretes que disparam mensagem a um CONTATO (relay), não só ao dono.
-- Ex.: "todo dia 21h boa noite pro Wender" / cobrança de rotina.

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS target_client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS relay_body TEXT;

CREATE INDEX IF NOT EXISTS idx_reminders_target_client
  ON reminders (tenant_id, target_client_id)
  WHERE target_client_id IS NOT NULL;
