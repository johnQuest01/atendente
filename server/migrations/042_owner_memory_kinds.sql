-- Amplia tipos de memória: a IA classifica sem keyword
-- (historia, problema além dos tipos anteriores).

ALTER TABLE owner_memories DROP CONSTRAINT IF EXISTS owner_memories_kind_check;
ALTER TABLE owner_memories ADD CONSTRAINT owner_memories_kind_check
  CHECK (kind IN (
    'fato',
    'evento',
    'acontecimento',
    'historia',
    'problema',
    'preferencia',
    'acao'
  ));
