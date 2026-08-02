-- 024: Lembretes pessoais do dono (assistente por WhatsApp).
--
-- O mesmo número que atende clientes também aceita comandos pessoais do dono
-- ("me lembra amanhã de pagar o fornecedor"). Quem está na whitelist
-- `reminder_owners` NÃO passa pelo fluxo comercial: não vira cliente, não abre
-- conversa no painel e não aciona a IA de vendas.
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Dono (só dígitos), casa com inbound.phone.
  owner_phone VARCHAR(20) NOT NULL,
  task TEXT NOT NULL,
  category VARCHAR(20) NOT NULL DEFAULT 'data_especifica'
    CHECK (category IN ('importante', 'rotina', 'data_especifica')),
  -- NULL = disparo único; senão a regra ('daily', 'weekly:FRI', 'monthly:20').
  recurrence TEXT,
  next_fire_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'enviado', 'concluido', 'cancelado')),
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  notes TEXT,
  last_fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_reminders_tenant_owner
  ON reminders (tenant_id, owner_phone, status);

-- Whitelist de números autorizados a usar o assistente pessoal, por empresa.
CREATE TABLE IF NOT EXISTS reminder_owners (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone VARCHAR(20) NOT NULL,
  label VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, phone)
);

-- RLS no mesmo padrão da 019: restringe quando `app.tenant_id` está setado e é
-- permissiva quando vazio — é o que deixa o agendador varrer todas as empresas
-- como tarefa de sistema, fora do ciclo de request.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['reminders', 'reminder_owners'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
      USING (
        coalesce(current_setting('app.tenant_id', true), '') = ''
        OR tenant_id::text = current_setting('app.tenant_id', true)
      )
      WITH CHECK (
        coalesce(current_setting('app.tenant_id', true), '') = ''
        OR tenant_id::text = current_setting('app.tenant_id', true)
      )
    $f$, t);
  END LOOP;
END $$;
