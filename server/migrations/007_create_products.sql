-- 007: Produtos com imagens
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  price_wholesale DECIMAL(10,2),       -- preço atacado
  min_quantity INTEGER DEFAULT 1,      -- quantidade mínima por pedido
  unit VARCHAR(50),                    -- ex: "caixa com 12", "fardo", "kg"
  image_urls TEXT[] DEFAULT '{}',      -- array de URLs das imagens
  keywords TEXT[] DEFAULT '{}',
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
