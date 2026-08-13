-- 052: Treino da secretária (ordens permanentes em linguagem natural).
-- Cada WhatsApp tem o próprio caderno: o dono escreve no app, a IA interpreta e executa.

ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS secretary_playbook TEXT;

COMMENT ON COLUMN whatsapp_connections.secretary_playbook IS
  'Ordens permanentes do dono para a secretária deste WhatsApp. Linguagem natural; a IA interpreta e executa. Vazio = só o comportamento padrão.';
