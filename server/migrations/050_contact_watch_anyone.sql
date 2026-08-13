-- 050: Aviso de QUALQUER pessoa (client_id nulo = todos neste WhatsApp).
-- "Me avisa quando qualquer um mandar mensagem" — um toque por contato, sem teto.

ALTER TABLE contact_message_watches
  ALTER COLUMN client_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_watches_active_anyone
  ON contact_message_watches (
    tenant_id,
    owner_phone,
    COALESCE(connection_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'active' AND client_id IS NULL;

COMMENT ON COLUMN contact_message_watches.client_id IS
  'Contato vigiado. NULL = qualquer pessoa neste WhatsApp.';
