-- 018: IA por empresa (modelo HIBRIDO) + teto de uso mensal.
--
-- ai_providers ganha tenant_id:
--   NULL      = provedor GLOBAL da plataforma (padrao; cobre todas as empresas)
--   <uuid>    = provedor da EMPRESA (BYO: a empresa conecta a propria chave)
-- Resolucao no orquestrador: usa a corrente da empresa; se ela nao tiver
-- nenhuma, cai na global; por fim, no .env. Quando a empresa traz as proprias
-- chaves, ELAS tem prioridade e o uso NAO conta no teto da plataforma.

ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS idx_ai_providers_active;
CREATE INDEX IF NOT EXISTS idx_ai_providers_scope_active
  ON ai_providers (tenant_id, is_active, priority);

-- Contador de uso mensal da IA POR EMPRESA (so conta o uso pago pela
-- plataforma — provedores globais/.env). ym = 'YYYY-MM' em UTC.
CREATE TABLE IF NOT EXISTS ai_usage (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ym CHAR(7) NOT NULL,
  used INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, ym)
);

-- Teto mensal de mensagens de IA da empresa no plano base (NULL = ilimitado).
-- Protege a margem: ao estourar, a plataforma para de responder com as chaves
-- DELA; a empresa pode conectar a propria chave para continuar sem limite.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS ai_message_limit INT;
