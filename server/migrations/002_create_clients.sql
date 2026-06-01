-- 002: Clientes (lojistas que falam pelo WhatsApp)
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) UNIQUE NOT NULL,  -- formato: 5511999999999
  name VARCHAR(150),
  company_name VARCHAR(200),
  segment VARCHAR(100),               -- ex: "farmácia", "mercado", "loja de roupa"
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  first_contact_at TIMESTAMPTZ DEFAULT NOW(),
  last_contact_at TIMESTAMPTZ DEFAULT NOW()
);
