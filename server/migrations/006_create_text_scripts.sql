-- 006: Scripts de mensagens de texto
CREATE TABLE IF NOT EXISTS text_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  category VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,               -- texto com variáveis: {{client_name}}, {{product_name}}
  keywords TEXT[] DEFAULT '{}',
  usage_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
