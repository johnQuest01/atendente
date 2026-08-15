-- 054: Compromisso pode DISPARAR uma ação (pesquisa na web), não só avisar.
-- fire_action=search → no horário o agendador busca de verdade e manda o resultado.

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS fire_action TEXT NOT NULL DEFAULT 'notify';

ALTER TABLE reminders
  DROP CONSTRAINT IF EXISTS reminders_fire_action_check;

ALTER TABLE reminders
  ADD CONSTRAINT reminders_fire_action_check
  CHECK (fire_action IN ('notify', 'search'));

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS search_query TEXT;

COMMENT ON COLUMN reminders.fire_action IS
  'notify = só avisa a tarefa; search = no horário pesquisa na web e manda o resultado.';

COMMENT ON COLUMN reminders.search_query IS
  'Consulta da pesquisa quando fire_action=search. Se vazio, usa o texto da tarefa.';
