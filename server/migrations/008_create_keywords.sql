-- 008: Mapeamento palavras-chave -> conteúdo
CREATE TABLE IF NOT EXISTS keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword VARCHAR(100) NOT NULL,
  intent VARCHAR(100) NOT NULL,        -- intenção classificada
  content_type VARCHAR(20) CHECK (content_type IN ('audio', 'text', 'product', 'claude')),
  content_id UUID,                     -- ID do áudio, script ou produto
  priority INTEGER DEFAULT 1,          -- maior = mais prioritário
  is_active BOOLEAN DEFAULT true
);

-- Índices de performance
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_client ON conversations(client_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_audios_category ON audios(category);
CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON keywords(keyword);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
