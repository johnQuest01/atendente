-- 025: aviso com antecedência no lembrete ("me avise 1h antes").
--
-- Modelado como DOIS toques do mesmo lembrete, não como dois registros: o
-- adiantado marca `lead_fired_at` e o principal segue no `next_fire_at` de
-- sempre. Duas linhas separadas duplicariam o item nas listas e quebrariam o
-- CONCLUIR/CANCELAR por índice.
--
-- Idempotente.

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS lead_minutes INT;

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS lead_fired_at TIMESTAMPTZ;

-- Teto de 7 dias: antecedência maior que isso quase sempre é erro de
-- interpretação da IA, não intenção do dono.
ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_lead_minutes_check;
ALTER TABLE reminders
  ADD CONSTRAINT reminders_lead_minutes_check
  CHECK (lead_minutes IS NULL OR (lead_minutes >= 1 AND lead_minutes <= 10080));

-- Índice para a varredura do aviso adiantado (só quem tem antecedência e ainda
-- não recebeu o toque).
CREATE INDEX IF NOT EXISTS idx_reminders_lead_due
  ON reminders (status, next_fire_at)
  WHERE lead_minutes IS NOT NULL AND lead_fired_at IS NULL;
