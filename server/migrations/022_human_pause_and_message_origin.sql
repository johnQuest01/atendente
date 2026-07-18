-- 022: pausa por intervenção humana + origem da mensagem no histórico.
-- Idempotente.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS human_paused_until TIMESTAMPTZ;

ALTER TABLE messages_log
  ADD COLUMN IF NOT EXISTS origin VARCHAR(20);

-- Valores: client | ai | human | system. Preenche legado por direção.
UPDATE messages_log
   SET origin = CASE
     WHEN direction = 'inbound' THEN 'client'
     ELSE 'ai'
   END
 WHERE origin IS NULL;

ALTER TABLE messages_log
  ALTER COLUMN origin SET DEFAULT 'client';

ALTER TABLE messages_log
  ALTER COLUMN origin SET NOT NULL;

ALTER TABLE messages_log DROP CONSTRAINT IF EXISTS messages_log_origin_check;
ALTER TABLE messages_log
  ADD CONSTRAINT messages_log_origin_check
  CHECK (origin IN ('client', 'ai', 'human', 'system'));
