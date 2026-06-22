-- 014: Multi-tenancy Fase 1 — Fundacao (isolamento por empresa).
-- Cria a entidade `tenants` (empresa) e adiciona tenant_id em TODAS as tabelas
-- de negocio. Tudo que ja existe e migrado, de forma nao-destrutiva, para um
-- tenant padrao (a operacao atual da Mayra = "Empresa 1").
-- UUID fixo do tenant padrao = constante DEFAULT_TENANT_ID no codigo.

-- ============================ Entidade raiz ============================
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(150) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tenants (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Empresa 1')
ON CONFLICT (id) DO NOTHING;

-- ============================ users ============================
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE users SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tenant_fk;
ALTER TABLE users ADD CONSTRAINT users_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- ============================ clients ============================
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE clients SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE clients ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_tenant_fk;
ALTER TABLE clients ADD CONSTRAINT clients_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
-- phone deixa de ser unico globalmente e passa a ser unico POR empresa.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_phone_key;
ALTER TABLE clients ADD CONSTRAINT clients_tenant_phone_key UNIQUE (tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_clients_tenant ON clients(tenant_id);

-- ============================ conversations (denormalizado) ============================
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE conversations SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE conversations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_tenant_fk;
ALTER TABLE conversations ADD CONSTRAINT conversations_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id);

-- ============================ messages_log (denormalizado) ============================
ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE messages_log SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE messages_log ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE messages_log DROP CONSTRAINT IF EXISTS messages_log_tenant_fk;
ALTER TABLE messages_log ADD CONSTRAINT messages_log_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages_log(tenant_id);

-- ============================ audios ============================
ALTER TABLE audios ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE audios SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE audios ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE audios DROP CONSTRAINT IF EXISTS audios_tenant_fk;
ALTER TABLE audios ADD CONSTRAINT audios_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_audios_tenant ON audios(tenant_id);

-- ============================ text_scripts ============================
ALTER TABLE text_scripts ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE text_scripts SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE text_scripts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE text_scripts DROP CONSTRAINT IF EXISTS text_scripts_tenant_fk;
ALTER TABLE text_scripts ADD CONSTRAINT text_scripts_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_text_scripts_tenant ON text_scripts(tenant_id);

-- ============================ products ============================
ALTER TABLE products ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE products SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE products ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tenant_fk;
ALTER TABLE products ADD CONSTRAINT products_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);

-- ============================ keywords ============================
ALTER TABLE keywords ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE keywords SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE keywords ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE keywords DROP CONSTRAINT IF EXISTS keywords_tenant_fk;
ALTER TABLE keywords ADD CONSTRAINT keywords_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_keywords_tenant ON keywords(tenant_id);

-- ============================ media_files ============================
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE media_files SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE media_files ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE media_files DROP CONSTRAINT IF EXISTS media_files_tenant_fk;
ALTER TABLE media_files ADD CONSTRAINT media_files_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_media_files_tenant ON media_files(tenant_id);

-- ============================ blocked_numbers ============================
ALTER TABLE blocked_numbers ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE blocked_numbers SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE blocked_numbers ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE blocked_numbers DROP CONSTRAINT IF EXISTS blocked_numbers_tenant_fk;
ALTER TABLE blocked_numbers ADD CONSTRAINT blocked_numbers_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE blocked_numbers DROP CONSTRAINT IF EXISTS blocked_numbers_phone_key;
ALTER TABLE blocked_numbers ADD CONSTRAINT blocked_numbers_tenant_phone_key UNIQUE (tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_blocked_numbers_tenant ON blocked_numbers(tenant_id);

-- ============================ settings (PK composta) ============================
ALTER TABLE settings ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE settings SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE settings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (tenant_id, key);
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_tenant_fk;
ALTER TABLE settings ADD CONSTRAINT settings_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
