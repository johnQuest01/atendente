# Mayra AI Sales

Sistema de atendimento e vendas **automatizado via WhatsApp** para loja B2B de atacado (dropshipping/intermediação). A IA **Mayra** responde clientes de forma humanizada alternando entre **áudios gravados**, **mensagens de texto** e **imagens de produtos**, enquanto a atendente real monitora tudo por um **painel web PWA** instalável no celular.

## Visão geral

- Clientes (lojistas) enviam mensagens no WhatsApp.
- A IA classifica a intenção e responde com áudio, texto ou produto — ou aciona o **Claude** para respostas livres.
- O painel PWA permite acompanhar conversas ao vivo, gerenciar áudios/scripts/produtos e mapear palavras-chave.

## Stack

| Camada | Tecnologias |
| --- | --- |
| Frontend | React 18, Vite, TypeScript, Tailwind, React Router v6, Zustand, TanStack Query v5, Axios, Socket.io-client, PWA (vite-plugin-pwa) |
| Backend | Node.js, Express, TypeScript, Socket.io, Multer, fluent-ffmpeg, Anthropic SDK, pg, JWT, bcrypt, Zod |
| Banco | PostgreSQL (Neon) com pooling e `sslmode=require` |
| Integrações | Z-API / Evolution API (WhatsApp), Anthropic Claude API |

## Estrutura do monorepo

```
.
├── client/   # Frontend React PWA
├── server/   # Backend Node.js + Express
├── package.json (npm workspaces)
└── .env.example
```

## Pré-requisitos

- Node.js >= 20
- Conta no [Neon](https://neon.tech) (PostgreSQL)
- `ffmpeg` instalado (para conversão de áudio). Em dev, o pacote `@ffmpeg-installer/ffmpeg` já é usado como fallback.
- Credenciais da Z-API e da Anthropic.

## Configuração

```bash
# 1. Instalar dependências (todos os workspaces)
npm install

# 2. Criar e preencher o .env na raiz
cp .env.example .env   # no Windows: copy .env.example .env

# 3. Rodar as migrations no banco Neon
npm run migrate

# 4. (Opcional) Criar usuário admin inicial
npm run seed --workspace server

# 5. Subir client + server em paralelo
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001
- Healthcheck: http://localhost:3001/health

## Scripts principais

| Comando | Descrição |
| --- | --- |
| `npm run dev` | Sobe server e client juntos |
| `npm run build` | Build de produção dos dois |
| `npm run typecheck` | Checa tipos sem emitir |
| `npm run migrate` | Aplica migrations SQL no banco |

## Webhook do WhatsApp

Configure na Z-API a URL do webhook de mensagens recebidas apontando para:

```
POST https://SEU_DOMINIO/webhook/whatsapp
```

## Licença

Privado — uso interno do projeto.
