-- 019: Row-Level Security (RLS) — defesa em profundidade contra vazamento entre
-- empresas (BUG 1). O isolamento por tenant continua na aplicação (filtros
-- WHERE tenant_id = ...); o RLS é a REDE DE PROTEÇÃO no próprio banco: mesmo que
-- uma query futura esqueça o filtro, o Postgres recusa linhas de outra empresa.
--
-- Estratégia da variável de sessão:
--   A aplicação seta `app.tenant_id` por requisição (SET LOCAL, em transação
--   curta) com o tenant do usuário autenticado / resolvido no webhook.
--   A policy só restringe quando a variável ESTÁ setada; quando vazia/ausente
--   (seed, migrations, super-admin que opera entre empresas) é PERMISSIVA, de
--   modo que operações de manutenção e cross-tenant legítimas não quebrem.
--   Como o app conecta como DONO das tabelas, usamos FORCE ROW LEVEL SECURITY
--   para que o RLS também se aplique ao owner.
--
-- Idempotente: ENABLE/FORCE são repetíveis e a policy é recriada (DROP IF EXISTS
-- + CREATE). Seguro sobre os dados atuais (todos já têm tenant_id).

-- Tabelas com tenant_id e isolamento "estrito" (sem linhas globais).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'clients', 'conversations', 'messages_log', 'audios', 'text_scripts',
    'products', 'keywords', 'media_files', 'blocked_numbers', 'settings',
    'users', 'whatsapp_connections', 'ai_usage'
  ];
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

-- ai_providers: além do tenant da empresa, há os provedores GLOBAIS da
-- plataforma (tenant_id IS NULL), que QUALQUER empresa pode LER no failover.
-- Por isso a policy também libera as linhas globais.
ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_providers;
CREATE POLICY tenant_isolation ON ai_providers
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
