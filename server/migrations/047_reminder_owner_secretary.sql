-- 047: Alavanca por número — libera o assistente secretário para outros usuários.
-- Quem já está na whitelist continua com acesso (DEFAULT true).

ALTER TABLE reminder_owners
  ADD COLUMN IF NOT EXISTS secretary_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN reminder_owners.secretary_enabled IS
  'Se true, este número usa secretária/agente neste WhatsApp. Se false, cai no fluxo comercial.';
