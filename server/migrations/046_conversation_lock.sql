-- 046: Cadeado de conversa no painel (só UI humana — não afeta IA/WhatsApp).

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN conversations.is_locked IS
  'Se true, o painel exige senha do tenant para ver mensagens. IA e webhooks ignoram.';
