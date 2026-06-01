1. VISÃO GERAL DO PROJETO
Estamos construindo o Mayra AI Sales, um sistema de atendimento e vendas automatizado via WhatsApp para uma loja B2B de atacado (sem estoque próprio — dropshipping/intermediação para varejistas).
O sistema funciona assim:

Clientes (lojistas varejistas) enviam mensagens no WhatsApp
A IA responde de forma humanizada, alternando entre áudios gravados pela atendente Mayra, mensagens de texto e imagens de produtos
A atendente Mayra monitora tudo por um painel web PWA instalável no celular
Pelo painel, Mayra pode adicionar novos áudios, editar scripts, cadastrar produtos e acompanhar conversas ao vivo


2. STACK TÉCNICA DEFINIDA
Frontend

React 18 com Vite
TypeScript obrigatório em todo o projeto
Tailwind CSS para estilização
PWA — manifest.json + service worker (Workbox via vite-plugin-pwa)
React Router v6 para navegação
Zustand para estado global
React Query (TanStack Query v5) para dados assíncronos e cache
Axios para chamadas HTTP
Socket.io-client para tempo real (conversas ao vivo)
Design focado em mobile-first iOS — comportamento nativo, safe areas, sem scroll horizontal

Backend

Node.js com Express
TypeScript obrigatório
Socket.io para WebSocket em tempo real
Multer para upload de arquivos de áudio e imagem
fluent-ffmpeg para conversão automática de áudio para .ogg/opus
Anthropic SDK (@anthropic-ai/sdk) para integração com Claude API
pg (node-postgres) para conexão com PostgreSQL
JWT para autenticação do painel da Mayra
bcrypt para hash de senhas
Zod para validação de schemas

Banco de dados

PostgreSQL hospedado no Neon (neon.tech)
Conexão via DATABASE_URL com pooling habilitado (?sslmode=require)
Migrations manuais em SQL puro (arquivos numerados em /server/migrations/)

Integrações externas

Z-API ou Evolution API para envio/recebimento de mensagens WhatsApp
Anthropic Claude API (modelo claude-sonnet-4-20250514) como IA de atendimento
Neon PostgreSQL como banco de dados principal


3. ESTRUTURA DE PASTAS DO PROJETO
mayra-ai-sales/
├── client/                          # Frontend React PWA
│   ├── public/
│   │   ├── manifest.json
│   │   ├── icons/                   # Ícones PWA (192x192, 512x512)
│   │   └── sw.js                    # Service Worker
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── routes/                  # Páginas principais
│   │   │   ├── Dashboard.tsx        # Visão geral + métricas
│   │   │   ├── Conversations.tsx    # Lista de conversas ao vivo
│   │   │   ├── ConversationDetail.tsx # Chat individual
│   │   │   ├── Audios.tsx           # Gerenciar áudios gravados
│   │   │   ├── Messages.tsx         # Gerenciar scripts de texto
│   │   │   ├── Products.tsx         # Cadastro de produtos/imagens
│   │   │   ├── Keywords.tsx         # Mapeamento de palavras-chave
│   │   │   └── Settings.tsx         # Configurações gerais
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── AppShell.tsx     # Shell com bottom nav (mobile) e sidebar (desktop)
│   │   │   │   ├── BottomNav.tsx    # Navegação inferior estilo iOS
│   │   │   │   └── Sidebar.tsx      # Sidebar para desktop
│   │   │   ├── ui/                  # Componentes base reutilizáveis
│   │   │   │   ├── Button.tsx
│   │   │   │   ├── Card.tsx
│   │   │   │   ├── Badge.tsx
│   │   │   │   ├── Input.tsx
│   │   │   │   ├── Modal.tsx
│   │   │   │   ├── AudioPlayer.tsx  # Player de áudio inline
│   │   │   │   └── FileUpload.tsx   # Upload drag-and-drop
│   │   │   └── features/
│   │   │       ├── ConversationCard.tsx
│   │   │       ├── AudioCard.tsx
│   │   │       └── ProductCard.tsx
│   │   ├── hooks/
│   │   │   ├── useConversations.ts
│   │   │   ├── useAudios.ts
│   │   │   ├── useSocket.ts
│   │   │   └── useAuth.ts
│   │   ├── store/
│   │   │   ├── authStore.ts
│   │   │   └── appStore.ts
│   │   ├── services/
│   │   │   └── api.ts               # Instância Axios configurada
│   │   ├── types/
│   │   │   └── index.ts             # Todos os tipos TypeScript
│   │   └── utils/
│   │       └── formatters.ts
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   └── package.json
│
├── server/                          # Backend Node.js + Express
│   ├── src/
│   │   ├── index.ts                 # Entry point — Express + Socket.io
│   │   ├── routes/
│   │   │   ├── auth.routes.ts       # POST /login
│   │   │   ├── conversations.routes.ts
│   │   │   ├── audios.routes.ts
│   │   │   ├── messages.routes.ts
│   │   │   ├── products.routes.ts
│   │   │   ├── keywords.routes.ts
│   │   │   └── webhook.routes.ts    # POST /webhook/whatsapp
│   │   ├── controllers/
│   │   │   ├── webhook.controller.ts   # Orquestrador principal da IA
│   │   │   ├── audios.controller.ts
│   │   │   ├── conversations.controller.ts
│   │   │   └── ...
│   │   ├── services/
│   │   │   ├── claude.service.ts    # Integração Anthropic API
│   │   │   ├── zapi.service.ts      # Envio WhatsApp via Z-API
│   │   │   ├── audio.service.ts     # Conversão ffmpeg + salvar banco
│   │   │   └── matcher.service.ts   # Classificação intenção → conteúdo
│   │   ├── middleware/
│   │   │   ├── auth.middleware.ts   # JWT validation
│   │   │   └── upload.middleware.ts # Multer config
│   │   ├── db/
│   │   │   ├── index.ts             # Pool de conexão Neon
│   │   │   └── queries/             # Queries SQL organizadas por domínio
│   │   │       ├── audios.ts
│   │   │       ├── conversations.ts
│   │   │       ├── messages.ts
│   │   │       ├── products.ts
│   │   │       └── keywords.ts
│   │   └── types/
│   │       └── index.ts
│   ├── migrations/
│   │   ├── 001_create_users.sql
│   │   ├── 002_create_clients.sql
│   │   ├── 003_create_conversations.sql
│   │   ├── 004_create_messages_log.sql
│   │   ├── 005_create_audios.sql
│   │   ├── 006_create_text_scripts.sql
│   │   ├── 007_create_products.sql
│   │   └── 008_create_keywords.sql
│   ├── uploads/                     # Áudios e imagens após upload (local dev)
│   └── package.json
│
├── .env.example
└── README.md

4. BANCO DE DADOS — SCHEMA COMPLETO (PostgreSQL / Neon)
sql-- 001: Usuários do painel (Mayra e admins)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 002: Clientes (lojistas que falam pelo WhatsApp)
CREATE TABLE clients (
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

-- 003: Conversas (sessão de atendimento por cliente)
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'closed', 'waiting')),
  assigned_to UUID REFERENCES users(id),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

-- 004: Log de todas as mensagens trocadas
CREATE TABLE messages_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  type VARCHAR(20) NOT NULL CHECK (type IN ('text', 'audio', 'image', 'document')),
  content TEXT,                        -- texto ou URL do arquivo
  audio_id UUID,                       -- referência se foi áudio do banco
  product_id UUID,                     -- referência se foi imagem de produto
  zapi_message_id VARCHAR(200),        -- ID retornado pela Z-API
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);

-- 005: Áudios gravados pela Mayra
CREATE TABLE audios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  category VARCHAR(100) NOT NULL,      -- ex: 'duvida_preco', 'confirmacao_pedido'
  tone VARCHAR(50),                    -- ex: 'empatico', 'firme', 'animado'
  situation TEXT,                      -- descrição de quando usar
  file_url TEXT NOT NULL,              -- URL do arquivo .ogg no storage
  file_size_kb INTEGER,
  duration_seconds INTEGER,
  transcription TEXT,                  -- transcrição para a IA entender o conteúdo
  keywords TEXT[],                     -- array de palavras-chave
  usage_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 006: Scripts de mensagens de texto
CREATE TABLE text_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  category VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,               -- texto com variáveis: {{client_name}}, {{product_name}}
  keywords TEXT[],
  usage_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 007: Produtos com imagens
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  price_wholesale DECIMAL(10,2),       -- preço atacado
  min_quantity INTEGER DEFAULT 1,      -- quantidade mínima por pedido
  unit VARCHAR(50),                    -- ex: "caixa com 12", "fardo", "kg"
  image_urls TEXT[],                   -- array de URLs das imagens
  keywords TEXT[],
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 008: Mapeamento palavras-chave → conteúdo
CREATE TABLE keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword VARCHAR(100) NOT NULL,
  intent VARCHAR(100) NOT NULL,        -- intenção classificada
  content_type VARCHAR(20) CHECK (content_type IN ('audio', 'text', 'product', 'claude')),
  content_id UUID,                     -- ID do áudio, script ou produto
  priority INTEGER DEFAULT 1,         -- maior = mais prioritário
  is_active BOOLEAN DEFAULT true
);

-- Índices de performance
CREATE INDEX idx_messages_conversation ON messages_log(conversation_id);
CREATE INDEX idx_conversations_client ON conversations(client_id);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_audios_category ON audios(category);
CREATE INDEX idx_keywords_keyword ON keywords(keyword);
CREATE INDEX idx_clients_phone ON clients(phone);

5. VARIÁVEIS DE AMBIENTE (.env)
env# Banco de dados Neon
DATABASE_URL=postgresql://user:password@ep-xxxxx.neon.tech/neondb?sslmode=require

# Autenticação
JWT_SECRET=sua_chave_secreta_muito_longa_aqui
JWT_EXPIRES_IN=7d

# Anthropic Claude API
ANTHROPIC_API_KEY=sk-ant-xxxxx
CLAUDE_MODEL=claude-sonnet-4-20250514

# Z-API (WhatsApp)
ZAPI_INSTANCE_ID=seu_instance_id
ZAPI_TOKEN=seu_token
ZAPI_BASE_URL=https://api.z-api.io/instances

# Storage de arquivos (áudios e imagens)
# Opção A: local (dev)
UPLOAD_DIR=./uploads
# Opção B: Cloudflare R2 ou AWS S3 (produção)
S3_BUCKET=mayra-ai-uploads
S3_ACCESS_KEY=xxxx
S3_SECRET_KEY=xxxx
S3_ENDPOINT=xxxx

# Servidor
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173

6. FLUXO PRINCIPAL — WEBHOOK (orquestrador da IA)
Quando chega uma mensagem do cliente via Z-API webhook (POST /webhook/whatsapp):
typescript// Fluxo dentro de webhook.controller.ts

1. Recebe payload da Z-API
2. Extrai: phone, message_text, message_type
3. Busca ou cria cliente na tabela clients
4. Busca ou cria conversa ativa na tabela conversations
5. Salva mensagem recebida em messages_log (direction: 'inbound')
6. Emite evento Socket.io para o painel da Mayra atualizar em tempo real
7. Chama matcher.service.ts:
   - Normaliza o texto (lowercase, remove acentos)
   - Busca keywords na tabela keywords que fazem match
   - Retorna: { content_type, content_id, intent }
8. Se content_type === 'audio':
   - Busca áudio na tabela audios
   - Envia via zapi.service.ts (sendAudio)
   - Registra em messages_log
9. Se content_type === 'text':
   - Busca script em text_scripts
   - Substitui variáveis {{client_name}} etc
   - Envia via zapi.service.ts (sendText)
10. Se content_type === 'product':
    - Busca produto em products
    - Envia imagens + preço formatado
11. Se content_type === 'claude' ou nenhum match:
    - Monta contexto com histórico da conversa (últimas 10 msgs)
    - Chama claude.service.ts com system prompt de vendas B2B
    - Recebe resposta humanizada
    - Envia como texto
12. Salva todas as respostas em messages_log (direction: 'outbound')
13. Incrementa usage_count no audio/script usado

7. SYSTEM PROMPT DA IA (claude.service.ts)
typescriptconst SYSTEM_PROMPT = `
Você é Mayra, atendente comercial da [NOME DA LOJA], especializada em vendas B2B de atacado.

PERFIL:
- Comunicação calorosa, direta e profissional
- Fala como uma vendedora experiente, não como um robô
- Usa linguagem natural brasileira — pode usar "oi", "olha", "perfeito"
- Nunca revela que é uma IA

CONTEXTO DO NEGÓCIO:
- Vendas exclusivas para lojistas (B2B) — não atende consumidor final
- Sem estoque próprio — trabalha com fornecedores
- Pedido mínimo por produto definido em cada item
- Prazo de entrega: 3 a 7 dias úteis (confirmar com fornecedor)
- Formas de pagamento: PIX (5% desconto), boleto 30 dias, cartão em 2x sem juros

OBJETIVOS EM ORDEM DE PRIORIDADE:
1. Entender o que o cliente precisa
2. Apresentar o produto certo com preço de atacado
3. Quebrar objeções de preço mostrando margem do varejista
4. Fechar o pedido ou agendar follow-up
5. Fidelizar com atendimento personalizado

REGRAS:
- Mensagens curtas (máximo 3 linhas por mensagem)
- Se o cliente pedir foto do produto, informe que vai enviar em seguida
- Nunca prometa prazo ou preço que não esteja confirmado
- Se não souber responder, diga que vai verificar e retorna em breve
- Em caso de reclamação, seja empática antes de resolver
`;

8. DESIGN DO APP — COMPORTAMENTO iOS NATIVO
Princípios obrigatórios:

Bottom navigation bar com 5 itens (igual apps iOS nativos)
Safe area respeitada: padding-bottom: env(safe-area-inset-bottom)
Status bar na cor do header: <meta name="theme-color">
Sem scroll horizontal em nenhuma tela
Pull-to-refresh nas listas de conversas
Haptic feedback simulado com animações suaves (scale 0.97 em taps)
Transições de página suaves (slide left/right entre rotas)
Inputs nunca ficam cobertos pelo teclado (scroll automático)
Toast notifications no topo para feedbacks rápidos

Paleta de cores:
css--color-primary: #6C47FF;      /* roxo principal */
--color-primary-light: #EEF0FF;
--color-success: #22C55E;
--color-warning: #F59E0B;
--color-danger: #EF4444;
--color-bg: #F8F8FA;           /* fundo geral */
--color-surface: #FFFFFF;      /* cards e modais */
--color-text-primary: #1A1A2E;
--color-text-secondary: #6B7280;
--color-border: #E5E7EB;
Telas do app:
1. Dashboard — Métricas do dia: conversas abertas, mensagens enviadas, áudios mais usados, gráfico de atividade
2. Conversas — Lista tipo WhatsApp: foto do cliente, último texto, horário, badge de não lidas. Filtros: Abertas / Aguardando / Fechadas
3. Chat individual — Bolhas de mensagem (inbound esquerda, outbound direita), indicador de áudio enviado com play inline, imagens expansíveis, barra de ação rápida na base (enviar áudio manual, enviar produto, mensagem livre)
4. Áudios — Grid de cards por categoria, player inline, badge do tom de voz, botão de upload com gravação via microfone do celular
5. Produtos — Grid de produtos com foto, preço atacado, quantidade mínima, badge de disponibilidade
6. Configurações — Dados do perfil, configurações da Z-API, testar webhook, ajustes do sistema

9. REGRAS DE DESENVOLVIMENTO

TypeScript strict — "strict": true no tsconfig, sem any explícito
Separação de responsabilidades — controllers finos, lógica nos services
Validação com Zod em todas as rotas do backend
Error handling centralizado — middleware errorHandler no Express
Queries parametrizadas — nunca concatenar SQL manualmente
Uploads de áudio — sempre converter para .ogg/opus com ffmpeg antes de salvar
Socket.io — emitir evento conversation:updated a cada nova mensagem
PWA — registrar service worker, cache de assets estáticos, manifest com ícones
Responsivo — mobile-first, breakpoint desktop em md: (768px)
Componentes — máximo 200 linhas por arquivo, extrair subcomponentes quando necessário


10. ORDEM DE CONSTRUÇÃO SUGERIDA
Fase 1 — Fundação
  [ ] Setup do monorepo (client + server)
  [ ] Configurar TypeScript em ambos
  [ ] Conexão com Neon PostgreSQL
  [ ] Rodar migrations SQL
  [ ] Autenticação JWT (login da Mayra)

Fase 2 — Backend core
  [ ] Webhook da Z-API funcionando
  [ ] matcher.service.ts (classificação por keywords)
  [ ] claude.service.ts (integração Anthropic)
  [ ] audio.service.ts (upload + conversão ffmpeg)
  [ ] zapi.service.ts (envio de texto, áudio, imagem)

Fase 3 — Frontend base
  [ ] AppShell com bottom nav iOS
  [ ] Roteamento React Router
  [ ] Autenticação + guard de rotas
  [ ] Tela de Conversas com Socket.io ao vivo

Fase 4 — CRUD completo
  [ ] Tela de Áudios (upload + player)
  [ ] Tela de Produtos (cadastro + imagens)
  [ ] Tela de Scripts de texto
  [ ] Tela de Keywords

Fase 5 — PWA e polish
  [ ] manifest.json + service worker
  [ ] Ícones e splash screen
  [ ] Animações de transição de página
  [ ] Dashboard com métricas reais
  [ ] Testes e ajustes finais

11. PRIMEIRO COMANDO PARA O CURSOR
Após colar este contexto, envie este comando como primeira instrução:
Com base em todo o contexto acima, comece pela Fase 1:

1. Crie a estrutura de pastas completa do projeto (client/ e server/)
2. Configure o package.json de ambos com todas as dependências listadas
3. Configure o TypeScript (tsconfig.json) em ambos com strict mode
4. Crie o arquivo server/src/db/index.ts com a conexão ao Neon PostgreSQL usando pool
5. Crie todos os arquivos de migration SQL em server/migrations/
6. Crie o .env.example com todas as variáveis necessárias
7. Configure o Express básico em server/src/index.ts com middleware de erro centralizado

Use TypeScript estrito em tudo. Não use 'any'. Implemente com código real e funcional, não com comentários TODO.
