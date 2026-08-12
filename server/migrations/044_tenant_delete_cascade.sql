-- Permite apagar empresas (tenants) com CASCADE nas FKs da 014 que
-- ainda não tinham ON DELETE CASCADE (users, clients, settings, etc.).

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid = 'tenants'::regclass
       AND c.conrelid::regclass::text IN (
         'users', 'clients', 'conversations', 'messages_log', 'audios',
         'text_scripts', 'products', 'keywords', 'media_files',
         'blocked_numbers', 'settings'
       )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE clients
  ADD CONSTRAINT clients_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE messages_log
  ADD CONSTRAINT messages_log_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE audios
  ADD CONSTRAINT audios_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE text_scripts
  ADD CONSTRAINT text_scripts_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE products
  ADD CONSTRAINT products_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE keywords
  ADD CONSTRAINT keywords_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE media_files
  ADD CONSTRAINT media_files_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE blocked_numbers
  ADD CONSTRAINT blocked_numbers_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE settings
  ADD CONSTRAINT settings_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
