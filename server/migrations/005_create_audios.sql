-- 005: Áudios gravados pela Mayra
CREATE TABLE IF NOT EXISTS audios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  category VARCHAR(100) NOT NULL,      -- ex: 'duvida_preco', 'confirmacao_pedido'
  tone VARCHAR(50),                    -- ex: 'empatico', 'firme', 'animado'
  situation TEXT,                      -- descrição de quando usar
  file_url TEXT NOT NULL,              -- URL do arquivo .ogg no storage
  file_size_kb INTEGER,
  duration_seconds INTEGER,
  transcription TEXT,                  -- transcrição para a IA entender o conteúdo
  keywords TEXT[] DEFAULT '{}',        -- array de palavras-chave
  usage_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
