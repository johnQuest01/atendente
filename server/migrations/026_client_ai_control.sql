-- 026: controle da IA POR CONTATO.
--
-- Até aqui o controle era grosseiro demais: ou a IA respondia todo mundo, ou
-- ninguém (flag global), ou o número era bloqueado por completo — e bloquear
-- descarta a mensagem, nem registra no painel.
--
-- `ai_enabled = false` é o meio-termo que faltava: a mensagem chega, aparece na
-- conversa e o humano responde, mas a IA fica calada NAQUELE contato.
-- `ai_prompt` deixa ajustar o comportamento do agente para um cliente
-- específico, somando-se à persona da empresa.
--
-- Idempotente.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS ai_prompt TEXT;

-- Teto para não estourar o contexto do modelo com um prompt gigante por contato.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_ai_prompt_len;
ALTER TABLE clients
  ADD CONSTRAINT clients_ai_prompt_len
  CHECK (ai_prompt IS NULL OR length(ai_prompt) <= 2000);
