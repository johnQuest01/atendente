-- 004: Log de todas as mensagens trocadas
CREATE TABLE IF NOT EXISTS messages_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  type VARCHAR(20) NOT NULL CHECK (type IN ('text', 'audio', 'image', 'document')),
  content TEXT,                        -- texto ou URL do arquivo
  audio_id UUID,                       -- referência se foi áudio do banco
  product_id UUID,                     -- referência se foi imagem de produto
  zapi_message_id VARCHAR(200),        -- ID retornado pela Z-API
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);
