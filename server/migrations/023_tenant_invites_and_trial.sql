-- 023: convite de empresa + período de teste (trial).
--
-- Ainda não há gateway de pagamento: o acesso ao produto é liberado por CONVITE
-- gerado pelo dono da plataforma. Ao aceitar, nasce a empresa com um prazo de
-- teste (`tenants.trial_ends_at`). Vencido o prazo, a API bloqueia o painel e o
-- atendente para de responder automaticamente, mas NADA é apagado.
--
-- Idempotente.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS tenant_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Token opaco que vai no link enviado ao futuro cliente.
  token TEXT NOT NULL UNIQUE,
  -- Opcional: trava o convite a um e-mail específico.
  email VARCHAR(255),
  -- Opcional: sugestão de nome da empresa (o cliente pode alterar no aceite).
  company_name VARCHAR(120),
  trial_days INT NOT NULL DEFAULT 14 CHECK (trial_days > 0 AND trial_days <= 365),
  -- Teto de mensagens de IA aplicado à empresa criada (NULL = ilimitado).
  ai_message_limit INT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  -- Preenchido no aceite, com a empresa que nasceu deste convite.
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_invites_open
  ON tenant_invites (used_at, expires_at);

-- RLS no mesmo padrão da 019. Esta tabela é de PLATAFORMA: o super-admin e o
-- endpoint público de aceite rodam sem `app.tenant_id`, então caem na cláusula
-- permissiva; linhas ainda não vinculadas têm tenant_id NULL.
ALTER TABLE tenant_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_invites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_invites;
CREATE POLICY tenant_isolation ON tenant_invites
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id IS NULL
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id IS NULL
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
