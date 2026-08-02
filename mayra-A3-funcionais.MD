# Mayra AI Sales — Verificação, rodada 3 de 3 🔵 FUNCIONAIS

> **Sessão limpa.** Não continue conversa anterior. Esta rodada cobre só os itens **7, 8 e 9**. As rodadas 1 e 2 já cobriram os itens 1–6 — não os re-verifique. Em particular, `webhook.controller.ts` já foi verificado noutras rodadas (itens 2 e 5); aqui você só olha o trecho do `fromMe` dele, nada mais.
>
> **Modo recomendado: Ask (somente leitura).**

## A regra

**Você não vai editar nenhum arquivo nesta tarefa.**

Sem escrever, criar, remover ou renomear. **Sem rodar o build.** Sem `npm install`. Sem branch, sem commit. Permitido: **ler arquivo, listar diretório, buscar no código.**

**Se você editar qualquer arquivo, a tarefa falhou.** Um diff nesta rodada é erro, não entrega.

Esta rodada tem mais pedido de inventário que as outras — é de propósito. Estou dimensionando as correções, não pedindo pra você fazê-las. As instruções de correção existem, estão comigo, e você recebe depois. Não peça. Não deduza. Não escreva.

## O repo

**Mayra AI Sales** (`atendente`): SaaS multi-tenant de atendente de vendas com IA via WhatsApp.

- `/server` — Node.js + Express + TypeScript · `/client` — React + Vite PWA
- PostgreSQL (Neon) com Row-Level Security · Cloudflare R2 · Socket.io
- Backend no Render, frontend na Vercel
- WhatsApp: Z-API (padrão) e Evolution API, via camada parcial em `server/src/services/whatsapp.service.ts` (`parseInbound`, `parseStatusUpdate`, `getTenantWhatsapp`, tipo `NormalizedInbound`)
- IA com failover: `providers/anthropic.ts`, `providers/openai.ts`, `providers/gemini.ts`

Uma auditoria externa apontou problemas com arquivo e linha. **O código mudou desde então — as linhas citadas estão desatualizadas.**

## Formato — um bloco por item, exatamente assim

```
### Item N — <título>
Arquivo alegado : <caminho:linha da auditoria>
Arquivo real    : <onde você de fato achou, ou "não existe">
Status          : CONFIRMADO | PARCIALMENTE CONFIRMADO | NÃO CONFIRMADO | ARQUIVO NÃO EXISTE

Evidência (colada do arquivo, com números de linha reais):
```ts
  187 |  temperature: 0.7,
```

Análise: <2 a 4 frases.>

Inventário: <só nos itens que pedem. Fatos lidos do código, não opinião.>
```

### Regras do relatório

1. **Evidência colada é obrigatória**, com números de linha reais. Não parafraseie. **Se você não consegue colar as linhas, você não leu o arquivo — o status é `ARQUIVO NÃO EXISTE`, não `CONFIRMADO`.**
2. **As linhas da auditoria estão velhas.** Reporte onde você **de fato** achou. Procure o arquivo inteiro antes de dar `NÃO CONFIRMADO`.
3. **`NÃO CONFIRMADO` é resultado válido e desejável.**
4. **Arquivo não existe? Diga.** Não deduza pelo nome.
5. **O inventário é leitura, não projeto.** Liste o que existe. Não sugira o que deveria existir.
6. Um item por vez, na ordem 7 → 8 → 9. Terminou? **Pare.**

---

## Item 7 — `fromMe` descartado

**Arquivo:** `server/src/controllers/webhook.controller.ts`

**Alegação:** mensagem com `inbound.fromMe === true` é totalmente ignorada (`ignored: 'fromMe'`) e **não é persistida**. Consequência: o histórico perde tudo que o operador humano escreveu, e a IA não sabe que um humano assumiu a conversa.

**Checar:**
- o early-return do `fromMe` ainda existe?
- existe algum conceito de "conversa assumida por humano" / pausa da IA, no código **ou** no schema?
- as mensagens enviadas pela própria automação passam por esse mesmo caminho? Existe registro dos IDs que a automação enviou (pra distinguir "humano digitou no celular" de "o bot respondeu")?

**Cole:** o trecho do `fromMe` e o entorno que decide persistir ou não.

**Inventário — leia e liste, sem propor nada:**
- os valores possíveis do campo de origem/papel em `messages_log` (enum, check constraint, ou coluna livre — leia o schema em `server/migrations/`)
- a assinatura de `getRecentMessagesForAI` e o que ela filtra
- se existe coluna/tabela guardando o `providerMessageId` das mensagens **enviadas** pela automação
- o número da última migration em `server/migrations/`

## Item 8 — Temperatura e maxTokens fixos no fluxo real

**Arquivo:** `server/src/services/ai.service.ts` (auditoria disse ~linha 187)

**Alegação:** o `generateReply` de produção usa `temperature: 0.7` e `maxTokens` fixos (500/700) hardcoded. O valor configurável só chega no `previewReply`. Resultado: o slider do painel não afeta resposta real nenhuma.

**Checar:**
- os literais ainda estão no `generateReply`?
- o `previewReply` de fato recebe valor configurável, e o `generateReply` não?
- de onde o `previewReply` tira o valor?

**Cole:** os dois trechos — o do `generateReply` e o do `previewReply` — no ponto onde `temperature` e `maxTokens` são montados.

**Inventário — leia e liste, sem propor nada:**
- quais settings por tenant existem hoje em `server/src/db/queries/settings.ts` (nomes das chaves e o mecanismo: tabela chave-valor? colunas? jsonb?)
- como a persona é persistida — é o padrão que `ai_temperature` seguiria
- nos três adaptadores (`providers/anthropic.ts`, `openai.ts`, `gemini.ts`): cada um já captura `finish_reason` / `stop_reason` da resposta da API? O resultado que eles devolvem tem campo pra isso? **Responda um por um, com a linha.**
- onde o slider de temperatura vive no client, e o que ele salva hoje

## Item 9 — CSP do client com `unsafe-inline` em script-src

**Arquivo:** `client/vercel.json`

**Alegação:** o header CSP contém `script-src 'self' 'unsafe-inline'`, enfraquecendo a proteção contra XSS — o que pesa porque o JWT vive no `localStorage`.

**Checar:**
- o header ainda tem `unsafe-inline` em `script-src`?
- o JWT está mesmo no `localStorage`? (busque no client)

**Cole:** o header CSP inteiro, como está no arquivo.

**Inventário — leitura do fonte apenas. NÃO rode `npm run build`:**
- existe `<script>` inline em `client/index.html`? Se sim, cole
- existe `dangerouslySetInnerHTML` no client? Onde?
- o `vercel.json` tem outros headers de segurança (HSTS, X-Frame-Options, X-Content-Type-Options)?

---

## Achados extras

Algo **grave** nestes arquivos que não está na lista? Seção final `## Achados extras`, com arquivo, linha e evidência colada. Sem corrigir. Não infle — se não for grave, não vá.

## Fechamento obrigatório

```
## Resumo — rodada 3/3
Item 7: <STATUS>
Item 8: <STATUS>
Item 9: <STATUS>

Arquivos editados nesta rodada: NENHUM
Build rodado: NÃO
```

### Confira antes de enviar

- [ ] Os 3 blocos preenchidos, um por item
- [ ] Evidência **colada** com número de linha real — nenhuma parafraseada
- [ ] Item 8: você respondeu sobre os **três** adaptadores separadamente, com linha
- [ ] O inventário lista o que **existe**, não o que deveria existir
- [ ] **Nenhum arquivo foi editado. O build não foi rodado.**
- [ ] Você não propôs nenhuma correção

Pare aqui. Eu junto as três rodadas e mando o plano de correção.
