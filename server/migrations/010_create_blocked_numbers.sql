-- 010: Números bloqueados. Mensagens recebidas de um número ativo aqui são
-- totalmente ignoradas: não são salvas, não aparecem no painel e o agente de
-- IA não responde. O campo is_active permite desligar o bloqueio sem apagar.
CREATE TABLE IF NOT EXISTS blocked_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(30) UNIQUE NOT NULL,   -- somente dígitos (normalizado)
  label VARCHAR(120),                  -- nome/observação opcional
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blocked_numbers_active ON blocked_numbers(phone) WHERE is_active;
