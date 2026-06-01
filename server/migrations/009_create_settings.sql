-- 009: Configurações globais (key-value). Usada para flags do sistema, como
-- ligar/desligar o atendente de IA (quando desligado, um humano responde).
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Por padrão o agente nasce ligado (mantém o comportamento atual).
INSERT INTO settings (key, value)
VALUES ('agent_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
