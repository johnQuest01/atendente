-- 027: Token de acesso por empresa, emitido pelo DONO DA PLATAFORMA (superadmin).
--
-- É a credencial/prova de acesso de cada empresa (tenant) ao SaaS. Só o
-- superadmin gera/revoga. O valor é guardado CIFRADO (AES-256-GCM, o mesmo
-- helper das credenciais de WhatsApp) para poder ser reexibido a quem pode ver,
-- MAIS um hash SHA-256 para lookup/verificação e um prefixo curto em claro para
-- identificar na UI. O token puro nunca é gravado.
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,              -- SHA-256 do token (verificação/lookup)
  token_encrypted TEXT NOT NULL,         -- AES-256-GCM p/ redecifrar e exibir
  token_prefix VARCHAR(16) NOT NULL,     -- primeiros chars em claro (identificar na UI)
  label VARCHAR(100),
  created_by UUID REFERENCES users(id),  -- o superadmin que gerou
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,                -- opcional (NULL = não expira)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_access_tokens_tenant ON access_tokens (tenant_id, is_active);

-- RLS no mesmo padrão da 019/024: restringe quando `app.tenant_id` está setado e
-- é permissiva quando vazio. Isso permite (a) o usuário ler só o token do próprio
-- tenant e (b) o superadmin varrer todos como tarefa de sistema (sem escopo).
ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON access_tokens;
CREATE POLICY tenant_isolation ON access_tokens
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
