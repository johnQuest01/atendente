# Prompt — Função de Assistente de Lembretes por WhatsApp (adição ao projeto `atendente` / Mayra AI Sales) — **REVISADO v2**

> Adicionar esta funcionalidade ao projeto EXISTENTE (repo `johnQuest01/atendente`, monorepo `mayra-ai-sales`). Escrito DEPOIS de ler a estrutura real do código. REUSA os padrões e módulos que já existem — NÃO reinventar.

---

## ⚠️ O que mudou nesta revisão (v2) — leia antes
Revisado contra o código real do repo. Três mudanças, todas confirmadas no fonte:

1. **O dono manda lembrete por TEXTO *ou* ÁUDIO.** A v1 só tratava `type === 'text'`. Um dono usando secretária no WhatsApp dita lembrete por voz ("me lembra amanhã de pagar o fornecedor"). O repo **já tem** o pipeline de transcrição (`server/src/services/transcription.service.ts`, usado hoje para áudio de cliente no `webhook.controller.ts`). O handler de lembrete deve **transcrever primeiro** (reusando esse serviço, com prompt de contexto PRÓPRIO) e só então parsear. Ver **PARTE 3B** e **PARTE 5** revisadas.

2. **Qualidade da transcrição é requisito de confiabilidade, não detalhe.** Para o áudio do DONO, palavra transcrita errada = lembrete errado = pagamento/compromisso perdido. A transcrição usa endpoint compatível com a OpenAI: trocar Groq → **GPT-4o-transcribe** é só `STT_BASE_URL` / `STT_MODEL` / `STT_API_KEY` no `.env` (sem tocar em código); Deepgram exigiria ajuste (API diferente). Ver **Nota de STT** no fim.

3. **Ponto de inserção no webhook corrigido.** No `processInbound` real, `findOrCreateClient` + `findOrCreateOpenConversation` rodam nas **linhas ~129–133**, ANTES de qualquer tratamento de mídia. Para o dono NÃO virar "cliente/conversa" no painel, o desvio tem que entrar **antes da linha 129** (antes de `findOrCreateClient`), e a condição do desvio passa a ser `type === 'text' || type === 'audio'`. Ver **PARTE 5** revisada.

O parser JÁ injeta data/hora atual + timezone (não chuma "hoje") — isso está correto, mantido.

---

## Estrutura real observada (contexto pro Grok) — confirmada no repo
- Monorepo com workspaces `client` e `server`. Foco: `server/`.
- **Server:** Node ≥20, TypeScript CommonJS, Express 4, `pg` puro (SEM ORM), `zod` p/ validação, `socket.io`, IA via `@anthropic-ai/sdk` (+ orchestrator multi-provedor), storage R2 via `@aws-sdk/client-s3`.
- **Multi-tenant com RLS.** Toda query roda no escopo do tenant via `runWithTenant(tenantId, fn)` (AsyncLocalStorage + `SET LOCAL app.tenant_id`). Tenant padrão: `DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001'` (`src/config/tenant.ts`).
  - **RLS confirmada (migration 019):** a policy `tenant_isolation` é **permissiva quando `app.tenant_id` está vazio/ausente** (`coalesce(current_setting('app.tenant_id', true),'') = '' OR ...`). Isso VALIDA o caminho do agendador como tarefa de sistema (ver PARTE 6).
- **Banco:** helpers em `src/db/index.ts` → `query<T>(text, params)`, `queryOne<T>(...)`, `withTransaction(fn)`. NUNCA concatenar SQL — sempre `$1,$2`. Migrations SQL sequenciais em `server/migrations/NNN_*.sql`, aplicadas por `src/db/migrate.ts` (tabela `_migrations`, roda em transação). `gen_random_uuid()` p/ PKs. **Último arquivo é `020_message_media.sql` → 021 é o próximo livre (confirmado).**
- **Queries por domínio:** `src/db/queries/*.ts` (ex.: `keywords.ts` com listX/getById/create/update recebendo `tenantId` como 1º arg e filtrando `WHERE tenant_id = $1`).
- **WhatsApp (envio + parsing):** fachada `src/services/whatsapp.service.ts` → `getTenantWhatsapp(tenantId)` devolve `TenantWhatsapp` com `sendText(phone, message)`, etc. Adaptadores `zapi.service.ts` / `evolution.service.ts`. Parsing: `parseInbound(provider, body)` → `NormalizedInbound { phone, text, type, messageId, senderName, fromMe, mediaUrl?, mediaBase64?, mediaMime?, ... }`. **`type` pode ser `'audio'`; `mediaUrl`/`mediaBase64` já vêm preenchidos para áudio (Z-API por URL, Evolution por base64) — confirmado.**
- **Transcrição (JÁ EXISTE):** `src/services/transcription.service.ts` expõe `transcribeAudioFromUrl(url, prompt?)` e `transcribeAudioFromBase64(base64, prompt?, filename?)`. Retornam `null` se STT desligado (`env.hasStt` false) ou sem mídia. Usa `POST {STT_BASE_URL}/audio/transcriptions` (compatível OpenAI). O `prompt?` enviesa o modelo e **melhora muito a precisão em áudio curto** — vamos usar isso a nosso favor no lembrete.
- **Webhook (entrada):** `src/controllers/webhook.controller.ts` → `handleWhatsappWebhook` resolve tenant+provider, chama `parseInbound`, e despacha para `processInbound(tenantId, inbound)` dentro de `runWithTenant`. É AQUI que a mensagem do usuário chega. Hoje já transcreve áudio de cliente via `transcribeInboundAudio` (privado nesse arquivo).
- **IA:** `src/services/ai.service.ts` + `src/services/ai/orchestrator.ts` (`complete(...)`, `isAiConfigured`, `hasVisionProvider`) + providers em `src/services/ai/providers/`. Usar o orchestrator — NÃO instanciar Anthropic cru.
- **Bootstrap:** `src/index.ts` (`start()`: cria app, sobe http, `initSocket`, trata SIGINT/SIGTERM). É onde o AGENDADOR será iniciado.
- **Config/env:** `src/config/env.ts` (inclui `hasStt`, `STT_BASE_URL`, `STT_MODEL`, `STT_API_KEY`, `STT_LANGUAGE`).
- **Infra:** `render.yaml` presente (Render). Processo de pé 24/7 → `setInterval` do agendador funciona nativamente (com ressalva de plano que hiberna).

---

## Objetivo da função
Um "secretário pessoal" do DONO, dentro do atendente: o dono escreve/**dita** compromissos e lembretes por WhatsApp em linguagem natural (**texto ou áudio**), o sistema interpreta (IA), CONFIRMA, salva, e AVISA por WhatsApp na data/hora. Também consulta por palavras-chave. NÃO se mistura com o fluxo de atendimento dos clientes.

## Decisão-chave: como distinguir o DONO dos clientes
O webhook hoje trata todo inbound como cliente e roda a IA de vendas. Para não conflitar:
- **Whitelist de números "dono/admin"** por tenant (tabela `reminder_owners`).
- No `processInbound`, **ANTES de `findOrCreateClient` (linha ~129)**: se `inbound.phone` está na whitelist do tenant E a mensagem é `text` OU `audio`, DESVIA para o handler de lembretes e RETORNA (não cria cliente, não cria conversa, não roda a IA de vendas). Caso contrário, segue o fluxo normal. (Posição exata na PARTE 5.)
- Assim o mesmo WhatsApp atende clientes E aceita comandos pessoais do dono, sem vazamento e sem poluir o painel.

---

## PARTE 1 — Migration (padrão `server/migrations/NNN_*.sql`)
Criar `server/migrations/021_reminders.sql` (021 é o próximo livre — confirmado):
```sql
-- 021: Lembretes pessoais do dono (assistente por WhatsApp)
CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_phone VARCHAR(20) NOT NULL,          -- dono (dígitos), casa com inbound.phone
  task TEXT NOT NULL,                          -- descrição ("pagar fornecedor X")
  category VARCHAR(20) NOT NULL DEFAULT 'data_especifica'
    CHECK (category IN ('importante','rotina','data_especifica')),
  recurrence TEXT,                             -- null = único; senão regra (ex.: 'weekly:FRI','monthly:20','daily')
  next_fire_at TIMESTAMPTZ NOT NULL,           -- próximo disparo (sempre preenchido)
  status VARCHAR(20) NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','enviado','concluido','cancelado')),
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  notes TEXT,
  last_fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_reminders_tenant_owner ON reminders (tenant_id, owner_phone, status);

-- Whitelist de donos autorizados a usar o assistente pessoal (por tenant).
CREATE TABLE IF NOT EXISTS reminder_owners (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone VARCHAR(20) NOT NULL,
  label VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, phone)
);
```
- **RLS:** seguir o MESMO padrão da 019 para `reminders` e `reminder_owners`: `ENABLE` + `FORCE ROW LEVEL SECURITY`, `DROP POLICY IF EXISTS tenant_isolation`, e recriar a policy com a mesma cláusula permissiva-quando-vazio:
  ```sql
  USING (coalesce(current_setting('app.tenant_id', true), '') = '' OR tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (coalesce(current_setting('app.tenant_id', true), '') = '' OR tenant_id::text = current_setting('app.tenant_id', true))
  ```
  (Idêntico às tabelas "estritas" da 019. Isso é o que permite o agendador varrer todos os tenants como tarefa de sistema.)

## PARTE 2 — Queries: `server/src/db/queries/reminders.ts`
Padrão de `keywords.ts` (funções recebem `tenantId` como 1º arg, usam `query`/`queryOne`, filtram por tenant):
- `isReminderOwner(tenantId, phone): Promise<boolean>`
- `createReminder(tenantId, { ownerPhone, task, category, recurrence, nextFireAt, timezone, notes }): Promise<Reminder>`
- `listReminders(tenantId, ownerPhone, filtro): Promise<Reminder[]>` — filtro por data/categoria
- `getDueReminders(limit): Promise<Reminder[]>` — para o agendador: `WHERE status='pendente' AND next_fire_at <= NOW()`. Roda FORA de request (ver PARTE 6).
- `markReminderFired(id, nextFireAt | null, newStatus)`
- `completeReminder(tenantId, ownerPhone, id)` / `cancelReminder(tenantId, ownerPhone, id)`
- Tipos em `src/types/index.ts` (`Reminder`, `ReminderCategory`).

## PARTE 3A — Parsing por IA (reusar o orchestrator)
Criar `server/src/services/reminders/parse.service.ts`:
- Usar `complete(...)` de `src/services/ai/orchestrator.ts` — NÃO instanciar SDK cru. Passar `tenantId`.
- O backend injeta DATA/HORA ATUAL + timezone do dono no prompt. Pedir JSON estrito.
- Prompt (system) sugerido:
```
Você é um extrator de lembretes. Data/hora atual: {AGORA_ISO} ({DIA_SEMANA_PT}), timezone {TZ}.
O usuário enviou: "{MENSAGEM}"
Responda APENAS JSON válido, sem texto extra:
{
  "task": "descrição curta",
  "type": "unico" | "recorrente",
  "due_at": "ISO 8601 se único, senão null",
  "recurrence": "regra se recorrente (weekly:FRI, monthly:20, daily), senão null",
  "category": "importante" | "rotina" | "data_especifica",
  "confirmation_text": "frase curta em pt-BR confirmando o que entendeu"
}
Regras de data relativa (a partir da data atual acima):
- "hoje"/"amanhã"; "quinta" = próxima quinta (se hoje é quinta e já passou a hora, a da semana seguinte);
- "dia N" = dia N deste mês, ou do próximo se já passou; "toda segunda" = weekly; "todo dia N" = monthly; "todo dia" = daily;
- "daqui a X dias" = hoje + X. Sem hora explícita, assumir 09:00 e dizer isso no confirmation_text.
- Se ambíguo, refletir a interpretação no confirmation_text.
```
- Validar o JSON com `zod`. Converter `due_at`/regra em `next_fire_at` no timezone do dono. Se o projeto não tem lib de tz, adicionar leve (`date-fns-tz`) OU calcular com `Intl`; documentar a escolha.

## PARTE 3B — **NOVO: transcrição do áudio do DONO (reusar transcription.service)**
Criar `server/src/services/reminders/transcribe-owner.ts` (ou função no handler):
- Se `inbound.type === 'audio'`, transcrever ANTES de parsear, reusando o serviço existente:
  ```ts
  import { transcribeAudioFromBase64, transcribeAudioFromUrl } from '../transcription.service';

  // Prompt de contexto PRÓPRIO do dono (NÃO o de vendas do webhook).
  // Enviesa o STT para vocabulário de lembrete → menos erro em áudio curto.
  const OWNER_STT_PROMPT =
    'O dono do negócio está ditando um lembrete pessoal em português do Brasil. ' +
    'Pode conter datas e horários (hoje, amanhã, segunda, dia 20, às 15h), e termos como ' +
    'pagar, boleto, fornecedor, cliente, reunião, ligar, cobrar, vencimento, entrega.';

  async function transcribeOwnerAudio(inbound: NormalizedInbound): Promise<string | null> {
    if (inbound.mediaBase64) {
      const t = await transcribeAudioFromBase64(inbound.mediaBase64, OWNER_STT_PROMPT);
      if (t) return t;
    }
    if (inbound.mediaUrl) return transcribeAudioFromUrl(inbound.mediaUrl, OWNER_STT_PROMPT);
    return null;
  }
  ```
- **Por que prompt próprio:** o `buildTranscriptionPrompt` do webhook enviesa para *"mensagem de voz de um cliente"* + frases-gatilho de venda — errado para o dono. Contexto certo = transcrição melhor.
- **Degradação:** se `env.hasStt` for false OU a transcrição voltar `null`, responder ao dono por texto: `"Recebi seu áudio, mas não consegui entender. Me manda por texto?"` e NÃO tentar parsear vazio. (Nunca criar lembrete a partir de transcrição vazia.)
- **Confiabilidade:** a transcrição é o gargalo de precisão do lembrete por voz. Ver **Nota de STT** no fim — para o dono, vale usar o STT de maior precisão.

## PARTE 4 — Handler de comandos (o "cérebro" do módulo)
Criar `server/src/services/reminders/handler.service.ts` com `handleOwnerMessage(tenantId, inbound): Promise<boolean>`:
- Retorna `true` se tratou (webhook então PARA), `false` se não era pra ele.
- **Passo 0 (NOVO):** determinar o texto do comando. Se `inbound.type === 'text'` → `text = inbound.text`. Se `inbound.type === 'audio'` → `text = await transcribeOwnerAudio(inbound)`; se `null`, responder pedindo texto e retornar `true` (tratou: era do dono, só não deu pra entender). Daqui pra frente o handler trabalha só com `text`, indiferente à origem.
- Fluxo:
  1. Se o dono está AGUARDANDO CONFIRMAÇÃO (estado por `owner_phone`): interpretar a resposta ("sim" salva; correção reprocessa). Estado curto em memória (Map + TTL, como o cache do `whatsapp.service.ts`).
  2. Consulta por PALAVRA-CHAVE (sem IA): "HOJE","AMANHÃ","SEMANA","MÊS"/nome do mês,"ROTINA","IMPORTANTES","TODOS" → `listReminders` filtrado → responder lista numerada via `getTenantWhatsapp(tenantId).sendText(phone, texto)`.
  3. Gestão: "CONCLUIR N" / "CANCELAR N" (N = índice da última lista; guardar a última lista por owner no Map) → `completeReminder`/`cancelReminder`.
  4. Cadastro: gatilho ("lembrar"/"lembra"/"me lembre"/"anota") OU heurística → `parse.service` → enviar `confirmation_text` e marcar "aguardando confirmação".
  5. Se nada casar, retornar `false` — OU (recomendado p/ o dono) responder um "menu de ajuda" curto, para o dono NUNCA cair no fluxo de vendas.

## PARTE 5 — Integrar no webhook (`webhook.controller.ts`) — **REVISADO**
**Posição corrigida:** no `processInbound(tenantId, inbound)`, **logo após a checagem de idempotência (linha ~124) e ANTES de `findOrCreateClient` (linha ~129)**:
```ts
// Assistente pessoal do dono (lembretes). Só para números na whitelist.
// Entra ANTES de findOrCreateClient para o dono NÃO virar cliente/conversa no painel.
// Aceita TEXTO ou ÁUDIO (o handler transcreve o áudio internamente).
if ((inbound.type === 'text' || inbound.type === 'audio') && (await isReminderOwner(tenantId, inbound.phone))) {
  const handled = await handleOwnerMessage(tenantId, inbound);
  if (handled) return; // não cria cliente, não cria conversa, não roda a IA de vendas
}
```
- Já está dentro de `runWithTenant` (o `processInbound` roda no escopo do tenant) — mantido.
- **Importante:** por entrar antes de `findOrCreateClient`/`findOrCreateOpenConversation`, o comando do dono não gera cliente nem conversa comercial no painel. (Se por acaso quiser registrar o dono num painel separado, faça isso DENTRO do handler, não no fluxo comercial.)

## PARTE 6 — Agendador (peça nova principal)
Criar `server/src/services/reminders/scheduler.service.ts` com `startReminderScheduler()`:
- `setInterval` a cada 60s. A cada tick: `getDueReminders(limit)` e, para cada:
  - `getTenantWhatsapp(reminder.tenant_id).sendText(reminder.owner_phone, "⏰ Lembrete: " + task)`.
  - Único: `markReminderFired(id, null, 'enviado')`.
  - Recorrente: recalcular `next_fire_at` pela `recurrence` (no timezone do lembrete) e `markReminderFired(id, proximo, 'pendente')`.
  - Idempotência: usar `last_fired_at`/status para não disparar duas vezes.
- **RLS (confirmado):** a policy da 019 é permissiva quando `app.tenant_id` está vazio. Então **opção (a): `getDueReminders` roda como tarefa de sistema** (SEM `runWithTenant`), varrendo TODOS os tenants; ao enviar, usa `getTenantWhatsapp(tenant_id)` de cada. Simples e correto. (Opção b — iterar tenants em `runWithTenant` — só se quiser isolamento extra; desnecessário aqui.)
- **Iniciar no bootstrap:** em `src/index.ts`, dentro de `start()` (após subir o server), `startReminderScheduler()`. Log de início.
- **Infra (Render):** `render.yaml` presente; processo 24/7 → `setInterval` funciona nativamente. ⚠️ Se o serviço estiver em plano free que hiberna, o agendador para na hibernação — usar plano sem hibernação OU um cron externo pingando `/health`. Documentar.

## PARTE 7 — (Opcional) Endpoints/painel
- Rotas em `src/routes/` + controller para gerenciar a whitelist (`reminder_owners`) e ver/editar lembretes pelo painel (React). Padrão de `keywords.routes.ts` + `keywords.controller.ts`. Não essencial no MVP (tudo via WhatsApp).

---

## Ordem de implementação sugerida
1. Migration 021 + queries `reminders.ts` + tipos.
2. Whitelist (`reminder_owners`) + `isReminderOwner`.
3. Consultas por palavra-chave + envio via `getTenantWhatsapp().sendText` (funciona sem IA e sem áudio).
4. Agendador (`scheduler.service`) + iniciar no `index.ts` + disparo no WhatsApp.
5. Integração no `webhook.controller` (desvio do dono, ANTES de `findOrCreateClient`, aceitando text+audio).
6. **Transcrição do áudio do dono (PARTE 3B)** reusando `transcription.service` com prompt próprio.
7. Cadastro por linguagem natural com IA (orchestrator) + confirmação.
8. Gestão (concluir/cancelar por número) e, se quiser, painel.

## Checklist
- [ ] Migration 021 no padrão (gen_random_uuid, tenant_id FK, CHECKs, índices) + policies RLS iguais às da 019 (permissiva-quando-vazio).
- [ ] `db/queries/reminders.ts` no padrão de keywords.ts (tenantId 1º arg, query/queryOne, WHERE tenant_id).
- [ ] Whitelist `reminder_owners` + `isReminderOwner(tenantId, phone)`.
- [ ] Desvio no `processInbound` **ANTES de `findOrCreateClient`**, condição `text || audio`, `handleOwnerMessage` → return (não cria cliente/conversa, não roda IA de vendas).
- [ ] **Áudio do dono:** `handleOwnerMessage` transcreve via `transcription.service` (`transcribeAudioFromBase64`/`FromUrl`) com **prompt de contexto PRÓPRIO** (não o de vendas); degrada pedindo texto se STT off/transcrição vazia; nunca parseia vazio.
- [ ] Consultas por palavra-chave (HOJE/AMANHÃ/SEMANA/MÊS/ROTINA/IMPORTANTES/TODOS) — filtro SQL, sem IA, resposta numerada.
- [ ] Cadastro natural: orchestrator `complete()` (NÃO SDK cru) + data/hora atual injetada + timezone + JSON validado por zod + confirmation_text.
- [ ] CONFIRMAÇÃO antes de salvar (estado "aguardando" por owner_phone via Map+TTL). Corrigir reprocessa.
- [ ] Datas relativas corretas a partir de "hoje" (quinta = próxima quinta, dia N, toda sexta, daqui a X). Timezone America/Sao_Paulo.
- [ ] Agendador setInterval 60s: dispara vencidos via getTenantWhatsapp().sendText; único→'enviado'; recorrente→recalcula next_fire_at; idempotente.
- [ ] Agendador iniciado no `src/index.ts` start(). RLS como tarefa de sistema (varre tenants). Nota de Render (não hibernar).
- [ ] Gestão concluir/cancelar por número da última lista.
- [ ] Reuso TOTAL da infra (whatsapp.service, transcription.service, orchestrator, db helpers, migrations) — sem duplicar, sem SQL concatenado, sempre no escopo do tenant.

## Nota de STT (qualidade da transcrição = confiabilidade do lembrete por voz)
- A transcrição usa `POST {STT_BASE_URL}/audio/transcriptions` (compatível OpenAI). Para o áudio do DONO, um erro de transcrição vira lembrete errado (ex.: valor/fornecedor/data trocados num lembrete de pagamento).
- **Sem tocar em código:** trocar Groq → **GPT-4o-transcribe** mudando só `STT_BASE_URL`, `STT_MODEL`, `STT_API_KEY` no `.env`. Testar com áudios reais.
- **Com pequeno ajuste (API diferente):** **Deepgram Nova-3** com vocabulário customizado (datas, "fornecedor", "boleto") tende a ser o mais preciso para PT-BR de WhatsApp — vale se a precisão do dono for crítica.
- O `prompt?` do `transcription.service` já enviesa o modelo; por isso a PARTE 3B usa um prompt de contexto de LEMBRETE (não o de vendas). Isso sozinho já reduz erro em áudio curto.

## Notas finais
- A parte confiável (agendador + consultas + gestão) NÃO depende de IA. A IA só interpreta o cadastro natural; a transcrição só entra no cadastro por voz — ambos com confirmação (crucial p/ pagamentos/cobranças).
- Respeitar multi-tenant/RLS em tudo. O assistente é POR TENANT e POR DONO (whitelist).
- Custo de IA baixo (uso pessoal). Transcrição só quando o dono manda áudio. Ambos passam pelos serviços que já controlam uso/limite.
- Construir a base primeiro (texto); voz e linguagem natural por último.

---

# ✅ verificado — lembretes implementados

Branch `fix/auditoria-b1-b2-b3`. Nada no `main`, nada deployado. Typecheck e build verdes.

| Parte | Resultado |
|---|---|
| 1 — Migration | ✅ executado (como **024**, não 021) |
| 2 — Queries `reminders.ts` | ✅ executado |
| 3A — Parsing por IA | ✅ executado |
| 3B — Transcrição do áudio do dono | ✅ executado |
| 4 — Handler de comandos | ✅ executado |
| 5 — Integração no webhook | ✅ executado |
| 6 — Agendador | ✅ executado |
| 7 — Endpoints/painel (opcional) | ✅ executado — virou necessário, veja abaixo |

## Três pontos em que o repo tinha mudado desde que este prompt foi escrito

**A migration é a 024, não a 021.** Entre a escrita deste prompt e agora entraram três migrations: 021 (provider metacloud), 022 (pausa por humano) e 023 (convites + trial).

**`inbound.messageId` virou `inbound.providerMessageId`.** A fase B2 renomeou o campo ao consolidar o `NormalizedInbound`. O código usa o nome novo.

**O ponto de inserção mudou de lugar.** O `processInbound` ganhou o `processFromMe` antes dele e a hidratação de mídia da Meta dentro dele, então as linhas ~124–133 citadas não existem mais. O desvio do dono ficou onde o prompt de fato queria: depois da checagem de idempotência e **antes** de `findOrCreateClient`, com a condição `text || audio`.

## Como ficou

**Migration 024** cria `reminders` e `reminder_owners` no padrão do repo (`gen_random_uuid`, FK para `tenants`, CHECKs, índices) e aplica RLS idêntica à da 019 — permissiva quando `app.tenant_id` está vazio, que é exatamente o que autoriza o agendador a varrer todas as empresas como tarefa de sistema.

**Fuso sem dependência nova.** Em vez de trazer `date-fns-tz`, escrevi `services/reminders/time.ts` em cima de `Intl`. A decisão que importa: a IA devolve horário de **parede** (`2026-08-03T09:00`, o que o dono leria no relógio) e a conversão para UTC acontece aqui. Pedir o offset ao modelo erraria no horário de verão. A conversão tem uma segunda passada justamente para a virada de DST, e `monthly:31` em mês curto cai no último dia em vez de pular o mês.

**Parsing** usa o orquestrador (`complete`), nunca SDK cru, com data/hora atual e dia da semana injetados, `temperature: 0` e JSON validado por zod. Três descartes explícitos, porque lembrete errado de pagamento é pior que lembrete nenhum: JSON malformado, `due_at` inválido e `due_at` no passado. E o texto de confirmação sempre leva a data já resolvida por nós — não dá para confiar que o modelo escreveu a data certa na frase.

**Áudio do dono** usa `transcription.service` com prompt de contexto **próprio** (vocabulário de lembrete: pagar, boleto, fornecedor, vencimento), não o de vendas do webhook. Sem STT ou com transcrição vazia, ele pede o texto — nunca parseia vazio.

**Handler.** Confirmação obrigatória antes de salvar, com estado por dono em Map + TTL de 15min. Responder qualquer coisa que não seja sim/não é tratado como **correção**: reprocessa juntando o texto original, então dá para dizer só “na verdade às 15h”. Consultas (HOJE, AMANHÃ, SEMANA, MÊS, ROTINA, IMPORTANTES, TODOS) e gestão (CONCLUIR N / CANCELAR N) são SQL puro, sem IA. Nada casou? Vai o menu de ajuda — o dono nunca cai no fluxo de vendas.

**Agendador** varre a cada 60s. Idempotência em duas camadas: `claimReminder` reserva a linha com `UPDATE ... WHERE status='pendente'`, então dois ticks concorrentes não disparam duas vezes; e um guard impede varreduras empilharem se um envio demorar. Falha de envio reagenda para +10min em vez de perder o lembrete. Empresa com teste vencido não recebe disparo, mas o lembrete volta para pendente em 6h em vez de sumir.

**Deduplicação própria.** As mensagens do dono não entram em `messages_log`, então não passam pelo `inboundMessageExists` que protege o fluxo comercial. Como os provedores reenviam webhook (a Meta insiste bastante), o handler guarda os ids recentes em memória — sem isso, um retry criaria o lembrete duplicado.

**A Parte 7 deixou de ser opcional.** Sem uma forma de cadastrar a whitelist, o recurso simplesmente não liga: nenhum número seria reconhecido como dono. Então entrou `GET/POST/DELETE /api/settings/reminder-owners` (só admin) e um card em Configurações → “Lembretes pessoais”.

## O que falta você fazer

- [ ] Rodar as migrations (023 e 024 são novas).
- [ ] Cadastrar seu número em Configurações → Lembretes pessoais, com DDI e DDD (`5511999998888`).
- [ ] Testar por texto primeiro, depois por áudio.
- [ ] **Render:** o agendador é `setInterval` num processo 24/7. Em plano que hiberna, ele para junto e os lembretes atrasam até alguém acordar o serviço. Use plano sem hibernação ou um cron externo batendo em `/health`.
- [ ] Se a precisão do áudio incomodar, troque o STT sem tocar em código: `STT_BASE_URL` / `STT_MODEL` / `STT_API_KEY`.