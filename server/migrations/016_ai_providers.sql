-- 016: Provedores de IA da plataforma (Claude/OpenAI/Gemini/Groq/OpenRouter/...).
-- Permite TROCAR de agente de IA e fazer FAILOVER automatico quando a cota/token
-- de um provedor acaba, sem perder a automacao. Configuracao GLOBAL da
-- plataforma (gerida pelo super-admin). As chaves ficam cifradas (AES-256-GCM).
--
-- A IA tenta os provedores ATIVOS em ordem de `priority` (menor = primeiro).
-- Em caso de erro de cota/limite/auth/transitorio, o provedor entra em
-- "cooldown" (cooldown_until) e o orquestrador passa para o proximo.

CREATE TABLE IF NOT EXISTS ai_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Adaptador usado para falar com a API:
  --   anthropic = Claude
  --   openai    = OpenAI/ChatGPT e qualquer API compativel (Groq, OpenRouter, local)
  --   gemini    = Google Gemini
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('anthropic', 'openai', 'gemini')),
  label VARCHAR(80) NOT NULL,
  -- Chave de API cifrada (nunca em texto puro).
  api_key_encrypted TEXT,
  -- URL base (para "openai-compatible": Groq/OpenRouter/local). Null = padrao do kind.
  base_url TEXT,
  model VARCHAR(120) NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- Estado de runtime (para o painel e para o cooldown do failover):
  last_status VARCHAR(20),        -- ok | auth | quota | rate_limit | transient | bad_request
  last_error TEXT,
  last_used_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,     -- enquanto no futuro, o provedor e' pulado
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ordena rapido os provedores ativos por prioridade (caminho quente do failover).
CREATE INDEX IF NOT EXISTS idx_ai_providers_active ON ai_providers (is_active, priority);
