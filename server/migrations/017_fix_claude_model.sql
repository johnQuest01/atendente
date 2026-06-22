-- 017: corrige o modelo do Claude que foi RETIRADO da API.
-- O modelo "claude-sonnet-4-20250514" nao existe mais e a API responde
-- 404 not_found_error, derrubando a geracao. Aponta o(s) provedor(es)
-- Anthropic que ainda usam esse modelo para o Sonnet atual disponivel.
-- Idempotente: so afeta linhas com o modelo antigo.

UPDATE ai_providers
   SET model = 'claude-sonnet-4-6',
       updated_at = NOW()
 WHERE kind = 'anthropic'
   AND model = 'claude-sonnet-4-20250514';
