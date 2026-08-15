-- 053: Horário semanal da secretária por número autorizado.
-- Com a alavanca ligada, este telefone só usa a secretária nos dias/horas
-- cadastrados. Fora da janela ela fica desligada e volta sozinha no próximo
-- horário (mesmo dia, dia seguinte, ou o minuto seguinte da grade).

ALTER TABLE reminder_owners
  ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS weekly_hours JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN reminder_owners.schedule_enabled IS
  'Se true, a secretária só atende este número nos horários de weekly_hours. Fora da janela fica desligada e religa sozinha no próximo horário.';

COMMENT ON COLUMN reminder_owners.weekly_hours IS
  'Mapa weekday 0-6 (0=domingo, America/Sao_Paulo) -> {start:"HH:mm", end:"HH:mm"}. Dia ausente ou null = fechado o dia todo. end < start = atravessa a meia-noite.';
