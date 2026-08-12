-- Telefone do usuário do painel (cadastro por convite).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone VARCHAR(30);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone)
  WHERE phone IS NOT NULL;
