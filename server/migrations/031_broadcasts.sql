-- 031: Disparos em massa (campanhas) com rastreio por destinatário.

CREATE TABLE IF NOT EXISTS broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title VARCHAR(150) NOT NULL,
  content_type VARCHAR(20) NOT NULL CHECK (content_type IN ('text', 'audio', 'product')),
  content_ref UUID,
  body_text TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'done', 'cancelled')),
  scheduled_at TIMESTAMPTZ,
  throttle_min_ms INT NOT NULL DEFAULT 8000,
  throttle_max_ms INT NOT NULL DEFAULT 25000,
  daily_cap INT NOT NULL DEFAULT 80,
  with_price BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcast_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (broadcast_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant_status
  ON broadcasts (tenant_id, status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_broadcast_targets_pending
  ON broadcast_targets (broadcast_id, status)
  WHERE status = 'pending';

ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON broadcasts;
CREATE POLICY tenant_isolation ON broadcasts
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );

ALTER TABLE broadcast_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON broadcast_targets;
CREATE POLICY tenant_isolation ON broadcast_targets
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
