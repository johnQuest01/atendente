# Mayra AI Sales — Correção B3: Fase 3 (bugs funcionais, itens 7–9)

> **Sessão nova, modo Agent.** O item 7 assume a estrutura da Fase 2 (`NormalizedInbound` formalizado). Os itens 8 e 9 são independentes — se você pulou a Fase 2, o 8 e o 9 ainda rodam.

## O PORTÃO

Como no B1: cada item tem `STATUS:`. Corrija só se `CONFIRMADO`/`PARCIALMENTE`. `NÃO CONFIRMADO` → pule. Vazio → pergunte.

```
<<< COLE AQUI o status dos itens 7, 8, 9 do relatório da rodada A3 >>>
```

## Regras

- Um commit por item. Item 7 e 8: `fix(ia): ...`. Item 9: `fix(seguranca): ...`.
- Migrations numeradas, idempotentes.
- `npm run typecheck` + build verdes ao final.
- Isolamento multi-tenant intocado.
- **Nunca** enviar ao cliente final uma resposta de IA visivelmente cortada.

---

## Item 7 — `fromMe` persistido + pausa por humano

`STATUS: ______`

**Arquivo:** `server/src/controllers/webhook.controller.ts`, e o schema de `messages_log`

Três partes:

1. **Persistir a mensagem `fromMe`** no histórico da conversa com origem "operador/humano". Verifique o enum/campo de origem em `messages_log` (a rodada A3 trouxe os valores possíveis) e amplie via migration se preciso. **Sem** disparar resposta da IA.

2. **Não confundir automação com humano.** Mensagem enviada pela **própria** automação também chega como `fromMe`. Distinga comparando `providerMessageId` com os IDs que a automação registrou ao enviar. Automação → não trata como intervenção humana, não duplica no histórico. Só `fromMe` **genuíno** (operador digitou no celular) conta como intervenção.

   > Se a rodada A3 reportou que **não existe** registro dos `providerMessageId` enviados pela automação, essa tabela/coluna precisa ser criada nesta correção — senão não há como distinguir os dois, e você cria loop ou duplicação. Reporte antes de implementar se for o caso.

3. **Pausa por intervenção humana.** `fromMe` genuíno numa conversa aberta → marca a conversa como "assumida por humano" por um período configurável (default **30 min**, env ou setting por tenant). Durante a pausa, a IA não responde àquela conversa. Exponha o estado no payload da conversa pro painel exibir.

4. Incluir essas mensagens no histórico que alimenta a IA (`getRecentMessagesForAI`), com o papel correto (assistant/operador), pra IA não perder o contexto do que o humano disse.

## Item 8 — Temperatura e maxTokens reais + truncamento

`STATUS: ______`

**Arquivo:** `server/src/services/ai.service.ts`, `db/queries/settings.ts`, os três adaptadores

1. **Persistir `ai_temperature` e `ai_max_tokens` como settings por tenant.** Siga o mecanismo que a rodada A3 identificou em `settings.ts` (o mesmo padrão da persona). Defaults **0.7** e **500**. Clamps de validação (temperatura 0–1 ou 0–2 conforme o provider; tokens num teto são).

2. **Usar esses valores no `generateReply` real** — não só no `previewReply`. Remover os literais `0.7` / `500` / `700` hardcoded.

3. **Ligar o slider** da seção "Personalidade da IA" do painel a esses settings, salvando junto com a persona.

4. **Truncamento** — nos três adaptadores (`providers/anthropic.ts`, `openai.ts`, `gemini.ts`): capturar `finish_reason` / `stop_reason`, propagar no resultado.
   > A rodada A3 reportou, adaptador por adaptador, quais já capturam isso. Para os que **não** capturam, adicione. Não assuma que os três são iguais — o relatório disse qual é qual.

   Se a resposta foi cortada por limite de tokens: logar e aplicar **uma** retentativa com o dobro do limite, **teto absoluto 1200**. Nunca mandar frase cortada pro cliente.

## Item 9 — CSP sem `unsafe-inline` em script-src

`STATUS: ______`

**Arquivo:** `client/vercel.json`

- Remover `'unsafe-inline'` do **`script-src`**. Build Vite padrão não precisa de script inline.
- A rodada A3 verificou se há `<script>` inline no `index.html`. Se houver algum inevitável, migre pra arquivo — **não** reintroduza `unsafe-inline` pra acomodá-lo sem antes reportar.
- Manter `'unsafe-inline'` **apenas em `style-src`** se o app depender disso (Vite/styled costumam depender).
- Peso extra: o relatório A3 disse se o JWT vive no `localStorage`. Se vive, este fix importa mais — XSS com token acessível é comprometimento de sessão. Não é escopo desta correção mover o JWT, mas anote como achado se ainda estiver no `localStorage`.

---

## Ao terminar a Fase 3

- `npm run typecheck` + build — cole a saída.
- Relatório final consolidando as três fases: itens corrigidos, itens pulados (com o motivo = status do relatório), migrations totais, envs novas.
- **Checklist de pós-deploy consolidado** (B1 + B3):
  - [ ] `BLOCK_ADMIN_*` no Render com senha nova
  - [ ] `npm run backfill-media-tokens`
  - [ ] `MEDIA_LEGACY_FALLBACK=false` depois do backfill
  - [ ] `WEBHOOK_VERIFY_TOKEN` setado
  - [ ] settings `ai_temperature` / `ai_max_tokens` com default por tenant
  - [ ] verificar pausa-por-humano num número real antes de anunciar
- Branch + PR. Não empurre no `main`.

---

# ✅ verificado — Fase 3 executada

Branch `fix/auditoria-b1-b2-b3`. Nada no `main`, nada deployado.

| Item | Resultado |
|---|---|
| 7 — `fromMe` + pausa por humano | ✅ executado |
| 8 — Temperatura, maxTokens e truncamento | ✅ executado |
| 9 — CSP sem `unsafe-inline` | ✅ executado |

**Item 7** — migration **022** adicionou `conversations.human_paused_until` e `messages_log.origin` (`client` / `ai` / `human` / `system`, com CHECK, default `client`, e backfill do legado por direção).

A distinção automação × humano usa `providerMessageExists()`: como a automação já grava o `zapi_message_id` ao enviar, um `fromMe` cujo ID já existe é eco do próprio bot e é ignorado — sem duplicar histórico, sem loop. Não precisei criar tabela nova; o registro já existia. `fromMe` genuíno é persistido com `origin='human'`, **sem** disparar a IA, e pausa a conversa por `HUMAN_TAKEOVER_MINUTES` (default 30). Durante a pausa `isHumanPaused()` bloqueia a resposta automática, e `human_paused_until` vai no payload da conversa para o painel exibir.

A parte 4 ficou completa nesta sessão: turnos com `origin='human'` entram no histórico como `assistant` prefixados com `[operador]`, e o system prompt ganha uma instrução condicional explicando que aquilo foi escrito por uma pessoa — para a IA não repetir o que o operador já disse nem copiar o marcador na resposta.

**Item 8** — `ai_temperature` (default 0.7) e `ai_max_tokens` (default 500) viraram settings por tenant em `settings.ts`, no mesmo padrão da persona, com cache e clamps (temperatura 0–1.5; tokens 50–1200). O `generateReply` real passou a lê-los; os literais `0.7` / `500` / `700` saíram. O slider da "Personalidade da IA" salva os dois junto com a persona.

Truncamento: os três adaptadores capturam o motivo de parada (`stop_reason` no Anthropic, `finish_reason` no OpenAI, `finishReason` no Gemini) e propagam via `AiCompletionResult { text, finishReason, truncated }`. Cortou por limite → loga e faz **uma** retentativa com o dobro, teto absoluto 1200. Se ainda vier cortada, a resposta é **descartada** e nada é enviado ao cliente.

**Item 9** — `'unsafe-inline'` removido do `script-src` em `client/vercel.json`. Mantido apenas em `style-src`, que o Vite precisa. Não há `<script>` inline no `index.html`, então nada precisou ser migrado para arquivo.

**Achado, sem correção (fora de escopo, como o prompt pede):** o JWT continua no `localStorage` — `client/src/services/api.ts` linhas 13–18, e o token do cadeado em `appStore.ts` linha 47. Com o `script-src` fechado o risco de XSS cai bastante, mas um token acessível por JavaScript segue sendo comprometimento de sessão se algum XSS passar. Migrar para cookie `httpOnly` exigiria mexer em auth no servidor e em CORS — decisão sua, em outra frente.

`npm run typecheck` e `npm run build` verdes.
