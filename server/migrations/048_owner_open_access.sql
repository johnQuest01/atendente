-- 048: Alavanca geral — secretário atende e busca livremente para qualquer pessoa.
-- Default false: sem isso, só os números cadastrados (com a alavanca por pessoa) entram.

ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS owner_open_access_enabled BOOLEAN;

COMMENT ON COLUMN whatsapp_connections.owner_open_access_enabled IS
  'NULL/false = só whitelist. true = qualquer número neste WhatsApp usa secretária + busca.';
