-- 015: Multi-tenancy Fase 2 — Conexao de WhatsApp por empresa + papel superadmin.
-- Cada empresa (tenant) passa a ter a PROPRIA conexao de WhatsApp (instancia
-- Z-API/Evolution), com credenciais criptografadas (AES-256-GCM) no app. O
-- webhook e roteado por empresa via um token opaco (webhook_token), de modo
-- que cada instancia poste em /webhook/whatsapp/<token>.
-- Tambem habilita o papel 'superadmin' (dono da plataforma), que cria e
-- gerencia as empresas.

-- ============================ whatsapp_connections ============================
CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL DEFAULT 'zapi' CHECK (provider IN ('zapi', 'evolution')),
  -- Segredos (instance id / token / client-token / api key) cifrados EM CONJUNTO
  -- como JSON (AES-256-GCM). Nunca guardamos credenciais em texto puro.
  secrets_encrypted TEXT,
  -- URL base do provedor (ex.: https://api.z-api.io/instances). Nao e segredo.
  base_url TEXT,
  -- Token opaco que vai na URL do webhook desta empresa: /webhook/whatsapp/<token>.
  webhook_token TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- Cache do ultimo status de conexao consultado (para a tela de status).
  last_status VARCHAR(20),
  last_status_detail TEXT,
  last_status_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uma conexao por empresa nesta fase (no futuro pode virar varias por empresa).
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_connections_tenant
  ON whatsapp_connections (tenant_id);

-- ============================ users.role: + superadmin ============================
-- O CHECK original (migration 001) so permitia 'admin'/'operator'. Adicionamos
-- 'superadmin' (dono da plataforma, gerencia as empresas) sem perder os dados.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'operator', 'superadmin'));
