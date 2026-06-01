-- 012: armazenamento genérico de mídia no banco (Neon).
-- Usado para imagens de produto (e qualquer outro arquivo) de forma que a
-- Z-API sempre consiga baixar, mesmo com disco efêmero ou host público mudando.
-- Servido por /media/files/:id.
CREATE TABLE IF NOT EXISTS media_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL DEFAULT 'image',
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  size_kb INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
