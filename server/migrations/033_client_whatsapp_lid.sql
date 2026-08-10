-- 033: WhatsApp @lid (Linked ID) por contato.
-- Mensagens fromMe da Z-API muitas vezes vêm só com o LID, sem o número.
-- Guardamos o lid no cliente real para casar o eco do celular com a conversa certa.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS whatsapp_lid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_tenant_whatsapp_lid
  ON clients (tenant_id, whatsapp_lid)
  WHERE whatsapp_lid IS NOT NULL;
