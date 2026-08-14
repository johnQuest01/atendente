# HANDBOOK — Mayra AI Sales (`atendente`)

Documento de referência para **outra IA** (ou humano) ler, entender o sistema inteiro e aplicar correções/avanços **sem inventar arquitetura**.

**Fonte da verdade:** o código em `server/` e `client/` + as migrations em `server/migrations/` + o schema real no Neon.  
**Não é fonte da verdade:** `fase.1.MD`, `fase.2.MD`, `prompt.MD`, `INSTRUCOES.MD`, `DEPLOY.md` (legado Render), `mayra-*.MD`, `upgrade.MD`, `persona.MD`. Esses arquivos descrevem intenções antigas; o código já avançou.

Data deste snapshot: **13 de agosto de 2026**. Schema conferido no Neon de produção (`muddy-dust-64962770`, branch `production`). Migrations aplicadas: **001 → 052**.

---

## 0. Como usar este documento

1. Leia as seções **1 (produto)**, **9 (invariantes)** e **10 (como evoluir)** antes de mexer.
2. Para um bug, identifique o **fluxo** (webhook comercial, secretária/dono, scheduler, painel, outbound/SAFE_MODE) e abra os arquivos citados.
3. Toda query de negócio precisa de `tenant_id`. Quase tudo operacional hoje também precisa de `connection_id`.
4. Não copie trechos de prompts `.MD` para o código. Se o código e o `.MD` divergirem, **o código vence**.
5. Não commite `.env`, senhas, tokens Z-API, `ENCRYPTION_KEY`, `JWT_SECRET`. Este handbook **não** contém secrets.

---

## 1. Identidade do produto

Monorepo npm workspaces: **atendente**.

Produto: atendimento e vendas **B2B atacado via WhatsApp**, com painel PWA, mais um **assistente pessoal (secretária)** no mesmo número.

| Papel | Quem | O que faz |
| --- | --- | --- |
| **Atendente de IA** | Cliente (lojista) manda zap | Responde com áudio/script/produto ou Claude. Fluxo comercial em `messages_log`. |
| **Secretária** | Dono (whitelist) ou, se ligado, qualquer número (acesso livre) | Lembretes, agenda, relay, watches, mute. Histórico em `owner_chat_messages`. **Não** entra no fluxo comercial. |
| **Agente do dono** | Mesmo WhatsApp, flag `owner_free_chat_enabled` | Chat livre com tools. Opt-in (custa token). |
| **Operador do painel** | Login JWT | Monitora conversas, catálogo, conexões. |
| **Superadmin** | Dono da plataforma | Tenants, convites, pool Z-API, IA global. |

Marca na UI: **“Agente de IA”**. Chaves internas: prefixo `mayra.*` no `localStorage`. Loja seed: `STORE_NAME=Maryland`. Persona default: Mayra.

Timezone de agenda: **`America/Sao_Paulo`** (`DEFAULT_TZ` em `server/src/services/reminders/time.ts`).

---

## 2. Arquitetura de produção (o que está no ar)

```
WhatsApp (Z-API)
    │  POST /webhook/whatsapp/:webhookToken
    ▼
Fly.io  app=mayra-api  região=gru  VM 512mb  1 CPU
    │  Express + Socket.IO + scheduler 60s
    │  ffmpeg no Docker
    │  volume mayra_uploads → /data/uploads (fallback local)
    │
    ├── Neon Postgres  (sa-east-1, PG 18)  DATABASE_URL
    ├── Cloudflare R2  (S3-compatible)     mídia pública permanente
    └── APIs: Anthropic/OpenAI/Gemini (orquestrador), Groq Whisper (STT), Tavily/Brave (busca)

Painel PWA  →  Vercel  (pasta client/)
    REST /api  +  Socket.IO  →  https://mayra-api.fly.dev
```

### 2.1 Fly.io (backend atual)

Arquivos: `fly.toml`, `Dockerfile`.

| Item | Valor |
| --- | --- |
| App | `mayra-api` |
| Região | `gru` (São Paulo, perto do Neon `aws-sa-east-1`) |
| Porta | `8080` |
| Máquinas | `min_machines_running = 1`, `auto_stop_machines = off` (webhook 24/7) |
| Volume | `mayra_uploads` → `/data` ; `UPLOAD_DIR=/data/uploads` |
| Health | `GET /health` a cada 15s |
| Release | `npm run migrate && npm run seed --workspace server` **antes** de trocar a máquina |
| Start | `npm run start --workspace server` → `node dist/index.js` |

Deploy típico: `git push` em `main` + `fly deploy --app mayra-api` (o usuário deste repo costuma fazer os dois).

`PUBLIC_BASE_URL` em prod: se vazio, deriva de `FLY_APP_NAME` → `https://mayra-api.fly.dev`.

### 2.2 Vercel (frontend)

Arquivo: `client/vercel.json`. Root Directory = `client`.

- SPA rewrite `/(.*) → /index.html`
- CSP + HSTS + `X-Frame-Options: DENY`
- Env: `VITE_API_URL` = URL do Fly **sem** `/api` (embutida no build; mudou → redeploy)

### 2.3 Render (legado)

`render.yaml` e `DEPLOY.md` descrevem backend no Render (Oregon, disco `/var/data`). **Produção atual é Fly.** `RENDER_EXTERNAL_URL` ainda é lido no `env.ts` como fallback de `PUBLIC_BASE_URL`.

### 2.4 Neon PostgreSQL (produção deste app)

| Item | Valor |
| --- | --- |
| Organização | Bruno (`org-steep-hat-29369072`) |
| Projeto | **`muddy-dust-64962770`** — nome **“atendente migrations”** |
| Branch | `production` (`br-noisy-silence-acu5ejey`) — primary/default |
| Região | `aws-sa-east-1` |
| Postgres | **18** |
| Autoscaling | 0.25–8 CU, `suspend_timeout_seconds: 0` (não hiberna) |
| Database | `neondb` (padrão Neon) |
| SSL | obrigatório (`DB_SSL=true`, `rejectUnauthorized: false` no client `pg`) |

**Outros projetos Neon na mesma org (NÃO são este app):**

- `curly-salad-18907507` — outro produto (tabelas `colecoes`, `registros`, `usuarios`, schema `neon_auth`). Não misturar.
- `shiny-credit-20324358` — pouco uso; não é o schema do atendente.

Runtime: pool `pg` em `server/src/db/index.ts`.  
- **Migrations/seed:** sempre `DATABASE_URL` (dono, DDL).  
- **App:** `APP_DATABASE_URL` se existir (papel **sem** `BYPASSRLS`); senão cai no dono.

### 2.5 Cloudflare

Não há Workers/Pages neste repo. Cloudflare entra em **dois** pontos:

1. **R2 (Object Storage)** — mídia de produção. SDK AWS S3 (`@aws-sdk/client-s3`). Endpoint: `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` ou `S3_ENDPOINT`. URL pública: `S3_PUBLIC_URL` (ex. `https://pub-xxxx.r2.dev` ou domínio próprio). Região `auto`.
2. **cloudflared (só dev)** — `client/vite.config.ts` `allowedHosts: true` para testar o PWA no celular via túnel. Não é produção.

Storage: `server/src/services/storage.service.ts`. Remoto só liga se **todas** existirem: endpoint + bucket + access key + secret + public URL. Senão: disco local `/uploads`.

Mídia inbound em prod: re-hospedada no R2 (`inbound-media.service.ts`). Em dev: `media_files` (BYTEA no Neon) servida em `/media/files/:id?t=`.

### 2.6 WhatsApp

Provedor de produção: **Z-API**. Evolution e Meta Cloud existem no código (`evolution.service.ts`, `whatsapp/metacloud.service.ts`) mas o `fly.toml` fixa `WHATSAPP_PROVIDER=zapi`.

Webhook canônico:

```
POST https://mayra-api.fly.dev/webhook/whatsapp/:webhookToken
```

`webhook_token` é opaco, único por linha em `whatsapp_connections`. **Nunca** confiar no body para escolher o tenant.  
Rota legado `/webhook/whatsapp` (sem token) só se `ALLOW_LEGACY_WEBHOOK=true` (default **false**).

---

## 3. Monorepo

```
atendente/
├── package.json          # workspaces: client, server
├── fly.toml
├── Dockerfile            # só o server + ffmpeg
├── render.yaml           # legado
├── client/               # Vite React PWA
└── server/
    ├── src/
    ├── migrations/       # 001–052 SQL puro
    └── scripts/          # ops, backfill, debug
```

Node `>= 20`. Scripts raiz: `dev`, `build`, `typecheck`, `migrate`, `lint`.

Dev: client `http://localhost:5173` (proxy `/api`, `/uploads`, `/health`, `/socket.io` → `:3001`). Server default `PORT=3001`.

---

## 4. Variáveis de ambiente

Arquivo: `server/src/config/env.ts` (Zod). Carrega `.env` da **raiz** do monorepo e fallback `server/.env`. Strings vazias = “não informado”.

### 4.1 Obrigatórias

| Variável | Notas |
| --- | --- |
| `DATABASE_URL` | Neon, com `sslmode=require` |
| `JWT_SECRET` | ≥16 chars; em produção ≥32 |

### 4.2 Importantes

| Variável | Default / papel |
| --- | --- |
| `APP_DATABASE_URL` | Runtime RLS (sem BYPASSRLS) |
| `NODE_ENV` | development/test/production |
| `PORT` | 3001 (Fly injeta 8080) |
| `FRONTEND_URL` | CORS; várias URLs separadas por vírgula |
| `ENCRYPTION_KEY` | AES-256-GCM das credenciais WhatsApp/IA no banco |
| `RLS_ENFORCE` | `true` — kill-switch sem rollback de migration |
| `SAFE_MODE` | `true` — inbound-only |
| `PUBLIC_BASE_URL` | URLs de mídia; Fly/Render auto-preenchem |
| `UPLOAD_DIR` | `./uploads` / Fly `/data/uploads` |
| `HUMAN_TAKEOVER_MINUTES` | 30 — pausa IA após `fromMe` humano |
| `DB_POOL_MAX` | 10 |
| `DB_SSL` | true |
| `MAX_TOOL_ITERATIONS` | 12 |
| `WHATSAPP_ONBOARDING_TIMEOUT_MINUTES` | 10 |
| `ZAPI_PROVISION_MODE` | `auto` \| `on-demand` \| `pool` |
| `ALLOW_LEGACY_WEBHOOK` | false |
| `MEDIA_LEGACY_FALLBACK` | true até backfill de tokens |
| `MEDIA_FETCH_ALLOWLIST` | SSRF: sufixos de host no download inbound |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | seed do dono da plataforma |
| `SEED_ADMIN_*` | só cria admin se o banco **não tem nenhum user** |
| `BLOCK_ADMIN_EMAIL` / `BLOCK_ADMIN_PASSWORD_HASH` | cadeado da blocklist (hash `scrypt$…`) |

### 4.3 IA / STT / busca

`ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (default `claude-sonnet-4-6`), `STT_PROVIDER` (`none`\|`openai`), `STT_API_KEY`, `STT_BASE_URL` (prod: Groq `https://api.groq.com/openai/v1`), `STT_MODEL` (`whisper-large-v3`), `STT_LANGUAGE=pt`, `SEARCH_PROVIDER` (`auto`\|`tavily`\|`brave`\|`none`), `TAVILY_API_KEY`, `BRAVE_API_KEY`. Legado: `WEB_SEARCH_PROVIDER`, `WEB_SEARCH_API_KEY`.

### 4.4 WhatsApp .env (legado / tenant padrão)

`WHATSAPP_PROVIDER`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`, `ZAPI_BASE_URL`, `ZAPI_PARTNER_TOKEN`, `EVOLUTION_*`, `WEBHOOK_VERIFY_TOKEN`. Multi-tenant usa credenciais **cifradas no banco** por conexão.

### 4.5 Cloudflare R2 / S3

`R2_ACCOUNT_ID`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_ENDPOINT`, `S3_REGION=auto`, `S3_PUBLIC_URL`. Tudo-ou-nada.

### 4.6 Frontend

`VITE_API_URL` — base **sem** `/api`. Vazio = same-origin (dev via proxy).

---

## 5. Backend (`server/`)

Entry: `server/src/index.ts`.

### 5.1 Boot

1. Express + `trust proxy` 1  
2. Helmet (`crossOriginResourcePolicy: cross-origin` para `/media` e `/uploads`)  
3. CORS (`server/src/config/cors.ts`) — allowlist `FRONTEND_URL` + preview Vercel do **mesmo** projeto + `https://api.z-api.io`  
4. JSON 5mb  
5. Static `/uploads`  
6. `/media` (sem JWT — Z-API baixa áudio; token `?t=` assinado)  
7. `GET /health` — DB + `current_user` + commit  
8. `/webhook` + rate limit 600/min  
9. `/api` + rate limit 1000/5min  
10. Socket.IO no mesmo HTTP server  
11. `startReminderScheduler()` (tick 60s)  
12. SIGINT/SIGTERM: para scheduler + fecha pool  

### 5.2 Árvore HTTP

```
GET  /health
     /uploads/*
     /media/audios/:id
     /media/files/:id
GET  /webhook/whatsapp/:webhookToken     # Meta verify
POST /webhook/whatsapp/:webhookToken     # inbound
POST /webhook/whatsapp                   # legado (410 se flag off)

/api/auth
/api/invites                             # público
/api/conversations
/api/audios
/api/messages                            # scripts de texto (NÃO chat)
/api/products
/api/keywords
/api/dashboard
/api/settings
/api/blocked
/api/admin                               # requireSuperAdmin
/api/broadcasts
/api/contacts
/api/whatsapp                            # onboarding
/api/tenants/:tenantId/whatsapp
```

Agregador: `server/src/routes/index.ts`.

### 5.3 Auth e tenant

| Peça | Arquivo |
| --- | --- |
| JWT Bearer | `middleware/auth.middleware.ts` → `req.user` + `runWithTenant(tenant_id)` (exceto superadmin) |
| Roles | `admin` \| `operator` \| `superadmin` |
| Trial/inativo | `tenantAccess.middleware.ts` → 402 `TRIAL_EXPIRED` / 403 `TENANT_INACTIVE` |
| Blocklist UI | header `x-block-token` |
| Chat lock | header `x-chat-unlock` (JWT scope `chat_unlock`) |
| Cadeado UI | `config/panel-lock.ts` — senha **hardcoded** (não é secret de produção real; não replicar em novos lugares) |

Tenant padrão (seed/legado): `DEFAULT_TENANT_ID = 00000000-0000-0000-0000-000000000001` (`config/tenant.ts`).

### 5.4 RLS

`server/src/db/index.ts`:

- `runWithTenant(id, fn)` guarda tenant em `AsyncLocalStorage`.
- Cada `query()` abre transação curta: `SET LOCAL app.tenant_id` + SQL + COMMIT. Não segura conexão durante IA/Z-API.
- `assertTenantMatchesScope` aborta query com tenant errado dentro do escopo.
- Sem escopo (scheduler, seed, superadmin): policy **permissiva**.
- `RLS_ENFORCE=false` desliga o SET LOCAL.

Policy padrão (migration 019 e tabelas novas): linha visível se `app.tenant_id` vazio **ou** igual a `tenant_id`.  
`ai_providers`: também libera `tenant_id IS NULL` (globais da plataforma).  
Tabela `tenants` **não** tem RLS (é a raiz). `instance_pool` tem RLS (pool é plataforma; jobs sem escopo enxergam tudo).

### 5.5 WhatsApp — inbound

Controller: `controllers/webhook.controller.ts`.

```
POST /webhook/whatsapp/:token
  → getConnectionByWebhookToken
  → parseStatusUpdate? markRead/Delivered → 200
  → onboarding event? → 200
  → parseInbound
  → bloqueado? ignore
  → responde 200 IMEDIATO (não espera IA)
  → fromMe? processFromMe : processInbound  (async, runWithTenant)
```

Detalhes críticos:

- Idempotência: `inboundMessageExists` / `providerMessageExists`.
- LID WhatsApp: `clients.whatsapp_lid` (migration 033) — eco `fromMe` da Z-API muitas vezes só traz LID.
- Meta: baixa mídia por `mediaId`.
- `fromMe` humano → `human_paused_until` = agora + `HUMAN_TAKEOVER_MINUTES`. Eco da IA **não** pausa.
- **Owner check ANTES de `findOrCreateClient` comercial.**

Owner entra se:

- `isReminderOwner(tenantId, phone, connectionId)` **ou**
- `connection.owner_open_access_enabled === true`

Aí `handleOwnerMessage()`; se retornar `true`, **acaba** (não vira cliente de vendas).

Acesso livre **sem** estar na whitelist: caderno próprio; **sem** tools de contato do dono (`listedOwner: false`). Não vazar agenda/CRM do dono.

### 5.6 WhatsApp — outbound

Ponto único: `services/dispatch.service.ts` → `assertCustomerOutboundAllowed` (SAFE_MODE) → `getWhatsappForConversation` → `sendText` / `sendAudio` / `sendImages`.

`OutboundMeta.sendType`: `reactive` precisa de `triggeringInboundId` não-vazio quando SAFE on. `proactive` (broadcasts, disparo manual sem inbound) **bloqueia**.

Relay/lembrete para contato também passa pelo dispatch — com SAFE on, relay proativo a cliente **é bloqueado**. Lembrete que só fala com o **dono** usa o client WhatsApp direto no scheduler (não é “envio a cliente”).

Business-initiated Meta: `outbound/business-initiated.ts` com `BUSINESS_INITIATED_ENABLED = false`. Z-API `businessInitiated = false`.

### 5.7 Fluxo comercial (cliente)

Arquivo: `webhook.controller.ts` `processInbound`.

1. `findOrCreateClient` + conversa aberta única por `(client_id, connection_id)`  
2. Travas: agent off, human pause, tenant blocked, `clients.ai_enabled === false`  
3. STT áudio, persist mídia, visão  
4. Fast path: `matcher.service.ts` (keywords → áudio/script/produto)  
5. Senão: `ai.service.ts` `generateReply` + `dispatchText` reactive  
6. Extração de memórias (`memory.service.ts`) em background  

Keyword `reminders_today` é **ignorada** no fluxo cliente (só dono).

Histórico comercial para IA: `getRecentMessagesForAI` — teto atual **200** mensagens (não 20).

### 5.8 Fluxo dono / secretária

Handler: `services/reminders/handler.service.ts` (~1600 linhas). Estado **em memória** por dono (`OwnerState`: pending SIM/NÃO, relay, watch, mute, cancel-all).

Camadas (ordem aproximada no handler):

1. Dedup `providerMessageId`  
2. STT se áudio (prefixo `[áudio]` no texto)  
3. Confirmação pendente SIM/NÃO (grava/cancela)  
4. Comandos estruturados: AJUDA, HOJE, agenda, cancelar, RECUPERAR/VARRER  
5. Watch / mute / relay parsers  
6. Parse NL de lembretes (`parse.service.ts`) — actions `create` | `update` | `acknowledge`  
7. Se secretária/agente ligados: `freeChatOwner()` (tools)  
8. Automações **não** devem “roubar” frases longas/áudio do agente: tools `anotar_compromisso`, `alterar_compromisso`, `cancelar_compromissos`

Parse (`parse.service.ts`):

- Schema JSON com `action`. `update` grava UPDATE no banco (SIM confirma).  
- **Não** listar agenda só porque a frase menciona compromisso. `detectQuery` exige pergunta real sobre a agenda (`isQuestion && mentionsAgenda`). Frases tipo “salva este compromisso para o Wender” **não** disparam listagem.  
- Horários vagos: madrugada ≈ 05:00, manhã ≈ 08:00.  
- Caderno recente entra no prompt do parse para editar item certo.

Flags por conexão (`whatsapp_connections`):

| Coluna | Efeito |
| --- | --- |
| `agent_enabled` | IA comercial (NULL = herda tenant) |
| `owner_secretary_enabled` | Secretária estruturada |
| `owner_free_chat_enabled` | Chat livre |
| `owner_web_search_enabled` | Tool `web_search` no chat dono |
| `owner_open_access_enabled` | Qualquer número usa secretária |
| `secretary_playbook` | Ordens permanentes NL |
| `ai_persona` / `ai_temperature` / `ai_max_tokens` | Override comercial |
| `reminder_assistant_persona` | Tom das confirmações |
| `memory_scan_enabled` | Comandos VARRER/RECUPERAR |

Whitelist: `reminder_owners` (`phone` + `connection_id` + `secretary_enabled`).

Chat dono: `owner-chat.service.ts`. Histórico até **2000** msgs/turno + tool `ler_historico_comigo` (offset). Fila por `(tenant, phone, connection)` para não cruzar turnos. Playbook aplicado na **saída** (`applySecretaryPlaybookToText`) — emoji/exceções por nome/número.

### 5.9 Tools do dono

Arquivo: `services/ai/tools/owner-actions.ts`.  
`buildOwnerToolRegistry(ctx, { contacts })`.

**Sempre (caderno):**

- `anotar_compromisso` — INSERT + disparo automático; `para_contato` só se `listedOwner`  
- `alterar_compromisso` — `caderno_n` 1-based  
- `cancelar_compromissos` — `todos=true` ou `caderno_n`  
- `ler_historico_comigo`  
- `listar_produtos`  

**Só se `contacts: true` (whitelist):**

- `buscar_contato`  
- `ler_conversa_contato` (padrão 200, máx 500, offset; inclui STT e descrição visual)  
- `enviar_mensagem_contato`  
- `agendar_mensagem_contato` (cria reminder com `target_client_id` + `relay_body`)  
- `avisar_quando_contato_falar`  
- `orientar_atendimento_contato`  
- `responder_contato` (mute `clients.ai_enabled`)  

Open access: `contacts: false` → **não** busca CRM do dono.

Tool global comercial: `web_search` em `services/ai/tools/index.ts` (Tavily/Brave).

### 5.10 IA orquestrador

`services/ai/orchestrator.ts` + adapters `providers/anthropic.ts`, `openai.ts`, `gemini.ts`.

Cadeia `resolveChain`:

1. Provedores **ativos do tenant** (filtro `connection_id` ou NULL = todas)  
2. Senão globais (`tenant_id IS NULL`)  
3. Senão, se **zero** cadastros no DB e existe `ANTHROPIC_API_KEY` → `.env`  

Se o tenant **já cadastrou** provedores e desligou todos, **não** ressuscita o `.env`.

Failover: cooldown memória + `cooldown_until` no DB. Tipos: auth, quota, rate_limit, transient, bad_request.  
Teto mensal `ai_usage` / `tenants.ai_message_limit`: só quando a plataforma paga (`source !== tenant`).  
Visão: filtra modelos sem imagem. Vídeo: `video-frames.ts`.

Persona comercial: `config/persona.ts` + placeholders `{NOME_DO_ATENDENTE}`, `{NOME_DO_NEGOCIO}`, `{O_QUE_O_NEGOCIO_FAZ_OU_VENDE}` preenchidos por behavior settings.

### 5.11 Scheduler (60s)

`reminders/scheduler.service.ts`:

1. `getDueLeadReminders` → aviso antecipado ao dono  
2. `getDueReminders` → `claimReminder` → dispara (texto ao dono **ou** relay ao contato + aviso) + grava em `owner_chat_messages`  
3. `tickBroadcasts()`  
4. `purgeExpiredMemories()` (LGPD `client_memories.expires_at`)  
5. `tickWhatsappOnboarding()` (QR expirado, devolve instância ao pool)  

Tenant bloqueado: reagenda +6h, não perde o lembrete.

### 5.12 SAFE_MODE

`outbound/safe-mode.service.ts`. Default env `true`. Override por tenant: setting `safe_mode`. Cache 5s.  
Bloqueio: `OutboundBlockedError` 403 + Socket `send:blocked`.  
UI: banner vermelho se OFF; card na Overview; confirmação ao desligar.

### 5.13 Outros serviços

| Domínio | Arquivos |
| --- | --- |
| Broadcasts | `broadcast.service.ts` — throttle jitter, `daily_cap`, máx 8 envios/tick, `connection_id` |
| Keywords | `matcher.service.ts`, `db/queries/keywords.ts` |
| Memória cliente | `memory.service.ts`, `client_memories` |
| Memória dono | `owner-memory.service.ts` kinds: fato, evento, preferencia, sensivel, historia, problema |
| Aliases | `owner-contact-memory.service.ts` — “Wender” não pergunta de novo |
| Watches | `contact-watch.service.ts` — once/always; `client_id` NULL = qualquer um |
| Mute | `contact-reply.service.ts` → `clients.ai_enabled` |
| Relay | `owner-relay.service.ts` |
| Playbook | `secretary-playbook.service.ts` — split por ponto; “exceto X”; emoji na saída |
| Onboarding | `whatsapp-onboarding.service.ts` — QR / phone code, Socket `whatsapp:status` |
| Pool Z-API | `zapi/InstanceProvisioner.ts`, `instance_pool` — trial→pool; active+partner→on-demand |
| Contatos | `contacts-sync.service.ts`, `contacts-export.service.ts` (VCF/JSON), paste-import |
| Chat lock | `chat-lock.service.ts` — só UI; IA/webhook ignoram `conversations.is_locked` |
| Health | `health.service.ts` — `/api/settings/status` (autenticado, detalhado) |
| Crypto | `utils/crypto.ts` — AES-256-GCM |
| Media token | `utils/media-token.ts` |

### 5.14 Socket.IO

`server/src/socket/index.ts`. Handshake `auth.token` JWT. Join `tenant:{id}`.

Emit: `conversation:updated|new`, `message:new`, `agent:status`, `blocklist:updated`, `safe_mode:status`, `send:blocked`, `whatsapp:status`.  
Recv: `conversation:join|leave`.

### 5.15 Imports circulares

- `webhook.controller` → `whatsapp-onboarding.service` via **dynamic import**.  
- Não importar `ai.service` / `webhook.controller` a partir de `orchestrator`, adapters ou `db/queries`.  
- `owner-actions.ts` puxa muitos serviços; não fechar o ciclo com `handler`/`owner-chat`.

### 5.16 Scripts (`server/scripts/`)

`hash-password.ts`, `backfill-media-tokens.ts`, `backfill-lids.mjs`, `link-one-lid.mjs`, `enable-sent-by-me.mjs`, `fix-webhook-once.mjs`, `fix-zapi-webhooks.mjs`, `fix-webhook-fly.sh`, `print-zapi-client-token.mjs`, `debug-zapi-webhook.mjs`, `debug-persona-tools.ts`, testes PowerShell de IA/áudio.

---

## 6. Frontend (`client/`)

Stack: React 18, Vite 6, RR v6, Tailwind 3, TanStack Query, Axios, Zustand, Socket.io-client, PWA (`vite-plugin-pwa`).

UI pt-BR, mobile-first, theme `#6D4AFF`.

### 6.1 Auth / API

`client/src/services/api.ts`:

- Base: `` `${VITE_API_URL ?? ''}/api` ``  
- JWT `localStorage mayra.token` → `Authorization: Bearer`  
- Sem cookie de sessão  
- `mayra.blockToken` → `x-block-token`  
- `sessionStorage mayra.chatUnlock.{conversationId}` → `x-chat-unlock`  
- 401 → logout (exceto `CHAT_LOCK_BAD_PASSWORD`)  
- `TRIAL_EXPIRED` / `TENANT_INACTIVE` → tela “Acesso pausado”

### 6.2 Rotas (`App.tsx`)

Públicas: `/login`, `/convite/:token`.  
Protegidas (AppShell):

| Path | Página |
| --- | --- |
| `/` | Conexões (home) |
| `/conexoes/nova` | Onboarding WhatsApp |
| `/conexoes/:connectionId` | Workspace (`?section=`) |
| `/conta` | Conta (`/configuracoes` redireciona) |
| `/painel` | Dashboard |
| `/conversas` | Lista (picker obrigatório se 2+ números) |
| `/conversas/:id` | Chat |
| `/audios` `/produtos` `/disparos` `/scripts` `/keywords` | Catálogo |
| `/colar-conversa` | Importar histórico colado |
| `/admin` | Superadmin |

### 6.3 Workspace da conexão (`?section=`)

`overview` | `playbook` | `ai` | `keywords` | `reminders` | `advanced`

- Overview: SAFE_MODE, toggle atendente, reconnect, credenciais, contatos  
- Playbook: textarea ordens da secretária  
- AI: persona vendas + preview  
- Keywords (conexão): só `reminders_today`  
- Reminders: owner modes, whitelist, persona lembretes, memory scan  
- Advanced: toggles Z-API, modelos IA tenant, behavior settings  

`canEdit`: admin/superadmin. Operator: leitura.

### 6.4 Roles UX

- `operator` lê  
- `admin` edita configs da empresa  
- `superadmin` vê `/admin` e `?manual=1` no create (credenciais manuais)

### 6.5 Nav

Primary (bottom): Conexões, Contatos, Produtos, Conta.  
Secondary (sidebar): Áudios, Disparos, Scripts, Keywords, Painel, Empresas.

Chat (`/conversas/:id`, `/colar-conversa`): some bottom nav e FAB cadeado.

### 6.6 Stores / hooks

Zustand: `authStore`, `appStore` (toasts + access block + block token).  
Hooks em `client/src/hooks/` espelham os endpoints (`useConversations`, `useSafeMode`, `usePersona`, `useReminderOwners`, `useWhatsappOnboarding`, `useBroadcasts`, `useAiProviders`, …).

### 6.7 Invariantes de UX

- Linguagem humana: “Conexões”, “Atendente de IA”, “Secretária”, “Modo seguro” — não jargão Z-API para o cliente.  
- Efeito imediato ao salvar persona/playbook/behavior.  
- Disparos e SAFE off: aviso de risco de ban.  
- Dois cadeados distintos: blocklist global vs lock por conversa.  
- Secretária ≠ atendente ≠ agente.

---

## 7. Banco de dados — schema real (Neon produção)

`*` = NOT NULL. Conferido em 2026-08-13 no projeto `muddy-dust-64962770`.

### 7.1 Tabelas

```
_migrations              id*, filename*, applied_at
tenants                  id*, name*, is_active*, created_at*, ai_message_limit, trial_ends_at, account_status* (trial|active|expired)
users                    id*, name*, email*, password_hash*, role, created_at, tenant_id*, phone
tenant_invites           id*, token*, email, company_name, trial_days*, ai_message_limit, expires_at*, used_at, tenant_id, created_by, created_at*
access_tokens            id*, tenant_id*, token_hash*, token_encrypted*, token_prefix*, label, created_by, is_active*, last_used_at, expires_at, created_at*, revoked_at

whatsapp_connections     id*, tenant_id*, provider*, secrets_encrypted, base_url, webhook_token*, is_active*,
                         last_status, last_status_detail, last_status_at, created_at*, updated_at*,
                         label, phone_number, ai_persona, ai_temperature, ai_max_tokens, agent_enabled,
                         reminder_assistant_persona, memory_scan_enabled,
                         provider_mode*, instance_origin*, connection_status*, webhook_configured*, zapi_subscribed*,
                         pool_instance_id, onboarding_started_at, onboarding_expires_at,
                         owner_free_chat_enabled, owner_web_search_enabled, owner_secretary_enabled,
                         owner_open_access_enabled, secretary_playbook
instance_pool            id*, secrets_encrypted*, provider_mode*, state*, assigned_tenant_id, assigned_connection_id, label, created_at*, updated_at*
connection_settings      tenant_id*, connection_id*, key*, value*, updated_at*

clients                  id*, phone*, name, company_name, segment, notes, is_active, first_contact_at, last_contact_at,
                         tenant_id*, ai_enabled*, ai_prompt, whatsapp_lid
conversations            id*, client_id, status (open|closed|waiting), assigned_to, started_at, closed_at, metadata jsonb,
                         tenant_id*, human_paused_until, connection_id, is_locked*
messages_log             id*, conversation_id, direction* (inbound|outbound), type* (text|audio|image|document|video),
                         content, audio_id, product_id, zapi_message_id, sent_at, delivered_at, read_at,
                         tenant_id*, media_url, media_mime, transcription, origin* (ai|human|system|…)

audios                   id*, title*, category*, tone, situation, file_url*, file_size_kb, duration_seconds,
                         transcription, keywords[], usage_count, is_active, created_by, created_at, file_data bytea, mime_type, tenant_id*
text_scripts             id*, title*, category*, content*, keywords[], usage_count, is_active, created_by, created_at, tenant_id*
products                 id*, name*, description, category, price_wholesale, min_quantity, unit, image_urls[], keywords[], is_available, created_at, tenant_id*
keywords                 id*, keyword*, intent*, content_type, content_id, priority, is_active, tenant_id*, connection_id
media_files              id*, kind*, mime*, data* bytea, size_kb, created_at, tenant_id*
blocked_numbers          id*, phone*, label, is_active*, created_at*, tenant_id*
settings                 key*, value*, updated_at*, tenant_id*     -- UNIQUE (tenant_id, key)

ai_providers             id*, kind*, label*, api_key_encrypted, base_url, model*, priority*, is_active*,
                         last_status, last_error, last_used_at, cooldown_until, created_at*, updated_at*,
                         tenant_id (NULL=global), connection_id (NULL=todas)
ai_usage                 tenant_id*, ym*, used*, updated_at*

client_memories          id*, tenant_id*, client_id*, kind* (fato|evento|preferencia|sensivel), summary*,
                         is_sensitive*, follow_up_at, source_message_id, expires_at, created_at*
broadcasts               id*, tenant_id*, title*, content_type* (text|audio|product), content_ref, body_text, status*,
                         scheduled_at, throttle_min_ms*, throttle_max_ms*, daily_cap*, with_price*, created_by,
                         started_at, finished_at, created_at*, updated_at*, connection_id
broadcast_targets        id*, tenant_id*, broadcast_id*, client_id*, status*, error, sent_at, created_at*

reminders                id*, tenant_id*, owner_phone*, task*, category*, recurrence, next_fire_at*, status*,
                         timezone*, notes, last_fired_at, created_at*, lead_minutes, lead_fired_at,
                         connection_id, target_client_id, relay_body
reminder_owners          tenant_id*, phone*, label, created_at*, connection_id*, secretary_enabled*

owner_chat_messages      id*, tenant_id*, connection_id, owner_phone*, role* (user|assistant), content*, provider_message_id, created_at*
owner_memories           id*, tenant_id*, connection_id, owner_phone*, kind*, summary*, occurred_at, source, created_at*
owner_contact_aliases    id*, tenant_id*, connection_id, owner_phone*, alias_key*, client_id*, created_at*, updated_at*
contact_message_watches  id*, tenant_id*, connection_id, owner_phone*, client_id (NULL=anyone), mode* (once|always), status*, last_notified_at, created_at*
```

Unicidades importantes:

- `clients (tenant_id, phone)`  
- conversa aberta: `(client_id, connection_id) WHERE status <> 'closed'`  
- `whatsapp_connections.webhook_token` único  
- `contact_message_watches` unique ativo por contato **e** unique “anyone” por owner/conexão  

### 7.2 RLS

Policy `tenant_isolation` (ALL) em quase todas as tabelas de negócio listadas na seção 5.4.  
`tenants` sem policy. Jobs sem `runWithTenant` veem tudo.

### 7.3 Runner de migrations

`server/src/db/migrate.ts`:

- Pasta `server/migrations/*.sql` ordenada por nome (`001_…`, `002_…`).  
- Tabela `_migrations (filename UNIQUE)`.  
- Cada arquivo: BEGIN → SQL → INSERT filename → COMMIT. Falha = ROLLBACK.  
- **Sempre** `DATABASE_URL` (owner).  
- Idempotência: arquivos usam `IF NOT EXISTS` / `DROP IF EXISTS` onde possível; **não reaplicam** se o filename já está em `_migrations`.

Nova migration: próximo número **053_**. Não edite SQL já aplicado em produção. Correção = arquivo novo.

### 7.4 Catálogo das migrations 001–052

| # | Arquivo | O que fez |
| --- | --- | --- |
| 001 | `create_users` | Painel: users |
| 002 | `create_clients` | Contatos WhatsApp |
| 003 | `create_conversations` | Sessões |
| 004 | `create_messages_log` | Log de mensagens |
| 005 | `create_audios` | Áudios gravados |
| 006 | `create_text_scripts` | Scripts |
| 007 | `create_products` | Catálogo |
| 008 | `create_keywords` | Matcher |
| 009 | `create_settings` | Key-value (depois ganha tenant_id) |
| 010 | `create_blocked_numbers` | Blocklist |
| 011 | `add_audio_blob` | BYTEA no Neon (disco efêmero) |
| 012 | `create_media_files` | BYTEA genérico |
| 013 | `unique_open_conversation` | 1 conversa aberta por cliente (depois refinado em 029) |
| 014 | `multi_tenant` | `tenants` + `tenant_id` em tudo; UUID fixo Empresa 1 |
| 015 | `whatsapp_connections` | Conexão por empresa + superadmin + webhook token |
| 016 | `ai_providers` | Cadeia global cifrada |
| 017 | `fix_claude_model` | Modelo retirado → `claude-sonnet-4-6` |
| 018 | `ai_per_tenant` | BYO + teto mensal |
| 019 | `row_level_security` | ENABLE/FORCE RLS |
| 020 | `message_media` | video + media_url/transcription |
| 021 | `whatsapp_provider_metacloud` | provider metacloud |
| 022 | `human_pause_and_message_origin` | `human_paused_until`, `origin` |
| 023 | `tenant_invites_and_trial` | convites + trial |
| 024 | `reminders` | lembretes + reminder_owners |
| 025 | `reminder_lead_time` | aviso antecipado |
| 026 | `client_ai_control` | `clients.ai_enabled`, `ai_prompt` |
| 027 | `access_tokens` | token API da empresa |
| 028 | `keywords_reminders_action` | content_type agenda |
| 029 | `multi_whatsapp_connections` | N números/tenant + IA por conexão + `conversations.connection_id` |
| 030 | `client_memories` | memória LGPD |
| 031 | `broadcasts` | campanhas + targets |
| 032 | `ai_providers_connection` | modelo por instância |
| 033 | `client_whatsapp_lid` | LID |
| 034 | `broadcast_reminder_connection` | connection_id em broadcasts/reminders |
| 035 | `keywords_connection` | keywords por número |
| 036 | `connection_scoped_settings` | `connection_settings` + persona/scan na conexão + owners por conexão |
| 037 | `whatsapp_onboarding` | trial/account_status, pool, QR metadata |
| 038 | `owner_agent_mode` | free chat + web search |
| 039 | `owner_secretary_agent_toggles` | secretária/agente/web (reafirma colunas) |
| 040 | `owner_chat_messages` | fio dono↔secretária |
| 041 | `owner_memories` | caderno do dono |
| 042 | `owner_memory_kinds` | kinds extras |
| 043 | `users_phone` | telefone no convite |
| 044 | `tenant_delete_cascade` | DELETE empresa com CASCADE |
| 045 | `reminder_contact_relay` | `target_client_id`, `relay_body` |
| 046 | `conversation_lock` | cadeado UI |
| 047 | `reminder_owner_secretary` | alavanca por número na whitelist |
| 048 | `owner_open_access` | qualquer número usa secretária |
| 049 | `contact_message_watches` | avisar quando contato falar |
| 050 | `contact_watch_anyone` | client_id NULL |
| 051 | `owner_contact_aliases` | apelido estável |
| 052 | `secretary_playbook` | `secretary_playbook` TEXT na conexão |

Seed (`db/seed.ts`): tenant padrão, admin só se zero users, promove superadmin, opcionalmente upsert conexão .env e primeiro `ai_providers` Anthropic.

---

## 8. Settings e behavior

Tabela `settings`: key-value **por tenant**.  
Overrides por conexão: `connection_settings` e colunas em `whatsapp_connections`.

Chaves conhecidas:

| Key | Uso |
| --- | --- |
| `agent_enabled` | Atendente comercial |
| `ai_persona` | System prompt vendas |
| `ai_temperature` | 0–1.5 |
| `ai_max_tokens` | 50–1200 |
| `reminder_assistant_persona` | Tom confirmação |
| `safe_mode` | Override do env |
| `ai_attendant_name` | placeholder nome |
| `ai_business_blurb` | placeholder negócio |

Registro UI: `config/behavior-settings.ts` — adicionar entrada = novo campo no painel sem UI custom.

Caches em memória TTL 5s em `db/queries/settings.ts` (write-through).

---

## 9. Invariantes (ler antes de qualquer PR)

1. **Isolamento:** `WHERE tenant_id = $1` em toda query de negócio + RLS. Webhook resolve tenant **só** pelo `webhookToken`.  
2. **Multi-WhatsApp:** conversa, keyword, broadcast, reminder, owner chat, playbook, IA — escopo `connection_id`. NULL em keywords/ai_providers = “vale para todas” (legado).  
3. **Uma conversa aberta** por `(client_id, connection_id)`.  
4. **Dono ≠ cliente.** Mensagens da secretária vão para `owner_chat_messages`, não para `messages_log` (salvo watches/inbound comercial em open access).  
5. **Open access não vaza CRM do dono.** Tools de contato só com `listedOwner`.  
6. **SAFE_MODE on:** zero envio proativo a cliente. Broadcasts exigem SAFE off.  
7. **Confirmação SIM** antes de gravar lembrete vindo do parser estruturado (pagamento/compromisso). Tools do agente podem gravar direto (`anotar_compromisso`) — comportamento atual intencional para áudio/frase longa.  
8. **Cancelar todos** = `cancelAllPendingReminders` (status cancelado) → saem da lista e o scheduler não dispara.  
9. **Não listar agenda** em texto livre que só pede para salvar compromisso.  
10. **Human takeover:** só `fromMe` genuíno.  
11. **Idempotência:** webhook por `providerMessageId`; reminders por `claimReminder`.  
12. **Cadeado de conversa** é só painel.  
13. **Não** importar orquestrador ← webhook de forma circular.  
14. **Migrations** são append-only.  
15. **Secrets** cifrados com `ENCRYPTION_KEY`. Trocar a key = recadastrar conexões.  
16. **ffmpeg** no Docker: áudio outbound `.ogg/opus` para WhatsApp.  
17. **Z-API precisa URL pública estável** para baixar áudio → R2 ou `/media/:id?t=`.  
18. Código de produto em **português** na UI; identificadores de código em inglês.

---

## 10. Como evoluir (playbook para a próxima IA)

### 10.1 Bug no WhatsApp do dono

Ordem: `webhook.controller.ts` (owner branch) → `handler.service.ts` → `parse.service.ts` / `owner-chat.service.ts` / tools.  
Não “consertar” listando agenda no `detectQuery`. Não misturar `messages_log` no fio do dono.

### 10.2 Bug no atendimento ao cliente

`webhook.controller.ts` `processInbound` → matcher → `ai.service.ts` → `dispatch.service.ts` → SAFE_MODE.

### 10.3 Não dispara lembrete

Scheduler 60s só vive se a VM Fly **não** dorme (`auto_stop off`). Conferir `claimReminder`, `status`, `next_fire_at`, `connection_id`, tenant `account_status`.

### 10.4 Nova coluna / tabela

1. `server/migrations/053_….sql` idempotente.  
2. Query em `server/src/db/queries/`.  
3. Se tabela com `tenant_id`: **ENABLE + FORCE RLS + policy** (copiar 019 / 030).  
4. Deploy: migrate no `release_command` do Fly.  
5. Atualizar este handbook.

### 10.5 Novo ajuste no painel

Preferir `BEHAVIOR_SETTINGS` ou coluna na conexão + seção existente. Não criar tela nova sem necessidade.

### 10.6 Novo provedor de IA

Adapter em `services/ai/providers/` + `model-catalog.ts` + linha em `ai_providers` (painel Admin ou tenant). Não hardcodar key no código.

### 10.7 Deploy

```
# API
git push origin main
fly deploy --app mayra-api

# Painel (Vercel auto na main, ou)
# conferir VITE_API_URL
```

Typecheck: `npm run typecheck`. Não usar `--no-verify`. Não force-push em `main`.

### 10.8 O que não fazer

- Não ligar `ALLOW_LEGACY_WEBHOOK` em prod.  
- Não enviar broadcast com SAFE on (vai 403).  
- Não logar tokens Z-API / API keys.  
- Não assumir 1 WhatsApp por tenant (isso morreu na 029).  
- Não usar o projeto Neon `curly-salad` para este app.  
- Não tratar `INSTRUCOES.MD` / `DEPLOY.md` como produção atual.

---

## 11. Inventário de arquivos-chave

### Backend

```
server/src/index.ts
server/src/config/{env,cors,tenant,persona,behavior-settings,panel-lock,logger}.ts
server/src/db/{index,migrate,seed}.ts
server/src/db/queries/*          # um arquivo por domínio
server/src/routes/*.ts
server/src/controllers/*.ts      # connectionScope.ts = parse connectionId
server/src/middleware/{auth,tenantAccess,rateLimit,validate,upload,error}.ts
server/src/socket/index.ts
server/src/services/whatsapp.service.ts
server/src/services/zapi.service.ts
server/src/services/zapi/{ZApiClient,InstanceProvisioner}.ts
server/src/services/evolution.service.ts
server/src/services/whatsapp/metacloud.service.ts
server/src/services/dispatch.service.ts
server/src/services/outbound/{safe-mode.service,business-initiated,types}.ts
server/src/services/ai/{orchestrator,service via ../ai.service.ts,providers/*,tools/*,model-catalog,vision,video-frames}
server/src/services/reminders/{handler,parse,scheduler,scan,time}.service.ts
server/src/services/owner-chat.service.ts
server/src/services/owner-memory.service.ts
server/src/services/owner-relay.service.ts
server/src/services/owner-contact-memory.service.ts
server/src/services/secretary-playbook.service.ts
server/src/services/contact-watch.service.ts
server/src/services/contact-reply.service.ts
server/src/services/broadcast.service.ts
server/src/services/matcher.service.ts
server/src/services/memory.service.ts
server/src/services/storage.service.ts
server/src/services/inbound-media.service.ts
server/src/services/whatsapp-onboarding.service.ts
server/src/services/chat-lock.service.ts
```

### Frontend

```
client/src/{main,App}.tsx
client/src/services/api.ts
client/src/hooks/*
client/src/store/{authStore,appStore}.ts
client/src/routes/*              # 16 páginas
client/src/components/connection/*
client/src/components/layout/*
client/src/components/features/*
client/src/components/admin/InstancePoolManager.tsx
client/src/components/ai/AiProvidersManager.tsx
```

### Infra

```
fly.toml  Dockerfile  client/vercel.json  render.yaml (legado)
```

---

## 12. Diagrama mental — mensagem inbound

```
WhatsApp → Z-API → POST /webhook/whatsapp/:token
                 → 200 imediato
                 → runWithTenant
                 → [status/onboarding] fim
                 → [bloqueado] fim
                 → [fromMe humano] pausa IA
                 → [owner whitelist | open access]
                       handleOwnerMessage → owner_chat / reminders / tools → FIM
                 → findOrCreateClient + conversation(connection_id)
                 → insert messages_log + Socket
                 → watches avisam dono
                 → [ai_enabled false | agent off | human pause] fim
                 → matchIntent? dispatch reactive
                 → senão generateReply → dispatchText reactive
                 → SAFE_MODE gate
                 → Z-API send
```

---

## 13. Dados operacionais úteis (não secrets)

- App Fly: `mayra-api`  
- Neon deste produto: `muddy-dust-64962770` / branch `production` / PG18 / `sa-east-1`  
- Tenant seed UUID: `00000000-0000-0000-0000-000000000001`  
- Health: `https://mayra-api.fly.dev/health`  
- Webhook: `https://mayra-api.fly.dev/webhook/whatsapp/<webhook_token da conexão>`  

Números de dono e IDs de conexão vivem no banco (`reminder_owners`, `whatsapp_connections`), não neste arquivo.

---

## 14. Checklist rápido para a IA que for corrigir

- [ ] Qual fluxo? (comercial / dono / scheduler / painel / SAFE)  
- [ ] Qual `tenant_id` e `connection_id`?  
- [ ] Mexeu em SQL? Migration nova + RLS se tiver `tenant_id`  
- [ ] Envio a cliente passa por `dispatch` + SAFE?  
- [ ] Open access não ganhou tool de contato?  
- [ ] Typecheck client+server  
- [ ] Não commitar `.env` nem `.MD` de prompt soltos sem o usuário pedir  
- [ ] Atualizar **este** handbook se o comportamento permanente mudou  

Fim.
