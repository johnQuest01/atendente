-- 028: palavra-chave que DISPARA os lembretes do dia (zero IA).
--
-- Amplia o CHECK de keywords.content_type para aceitar 'reminders_today'. Quando
-- o DONO (número na whitelist) manda essa palavra, o handler responde a lista de
-- hoje via SQL puro — sem chamar a IA. Para esse tipo, content_id fica NULL.
--
-- Idempotente.

ALTER TABLE keywords DROP CONSTRAINT IF EXISTS keywords_content_type_check;
ALTER TABLE keywords ADD CONSTRAINT keywords_content_type_check
  CHECK (content_type IN ('audio', 'text', 'product', 'claude', 'reminders_today'));
