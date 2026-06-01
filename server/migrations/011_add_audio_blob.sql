-- 011: guarda o conteúdo do áudio no próprio banco (Neon).
-- Motivo: o disco do servidor pode ser efêmero (Render) e o host público
-- (túnel cloudflared) muda/expira, deixando as URLs antigas inacessíveis para
-- a Z-API. Com os bytes no banco, o áudio é servido por /media/audios/:id de
-- forma estável e sobrevive a qualquer deploy/reinício.
ALTER TABLE audios ADD COLUMN IF NOT EXISTS file_data BYTEA;
ALTER TABLE audios ADD COLUMN IF NOT EXISTS mime_type TEXT;
