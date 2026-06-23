-- 020: persistencia e exibicao de midia recebida nas conversas.
-- Adiciona suporte ao tipo 'video' e colunas para guardar a URL/mime da midia
-- (imagem, video, audio, documento) re-hospedada por nos, alem da transcricao
-- do audio separada do texto. Tudo opcional e retrocompativel (NULL = sem midia).

-- 1) Permitir o tipo 'video' (alem de text/audio/image/document).
--    Remove QUALQUER check do campo "type" (o nome pode variar entre ambientes)
--    e recria com a lista atualizada. Assim a migration nao depende do nome.
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'messages_log'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE messages_log DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;

ALTER TABLE messages_log
  ADD CONSTRAINT messages_log_type_check
  CHECK (type IN ('text', 'audio', 'image', 'video', 'document'));

-- 2) Colunas de midia.
--    media_url     : URL publica ESTAVEL do arquivo re-hospedado (R2 ou /media).
--    media_mime    : content-type (define como o painel renderiza/baixa).
--    transcription : texto do audio transcrito (separado do "content").
ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS transcription TEXT;
