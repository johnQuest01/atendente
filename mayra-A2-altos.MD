# Mayra AI Sales — Verificação, rodada 2 de 3 🟠 ALTOS

> **⚠️ BRUNO — LEIA ANTES DE COLAR.** Este prompt tem dois espaços marcados `<<< COLE AQUI >>>`. Rode os comandos, cole a saída, **e só então** mande pro modelo. Se colar sem preencher, o modelo não tem como verificar os itens 4 e 6 em modo Ask (que não roda terminal) — e em modo Agent ele ia rodar `npm audit fix` e editar seu `package-lock.json`. Preencher você mesmo mata os dois problemas.
>
> ```bash
> cd server && npm audit --json | head -c 4000     # comando 1
> node -p "require('./package.json').dependencies.multer"   # versão do multer
> ```
> ```sql
> -- comando 2, no console do Neon
> select 'audios' t, count(*) from audios where file_url like '/media/%' and file_url not like '%?t=%'
> union all select 'media_files', count(*) from media_files where url like '/media/%' and url not like '%?t=%'
> union all select 'messages_log', count(*) from messages_log where media_url like '/media/%' and media_url not like '%?t=%';
> -- ajuste o nome das colunas se não bater
> ```

---

> **Sessão limpa.** Não continue conversa anterior. Esta rodada cobre só os itens **4, 5 e 6**. A rodada 1 já cobriu os itens 1–3 — não os re-verifique. Os itens 7–9 vêm na rodada 3.
>
> **Modo recomendado: Ask (somente leitura).**

## A regra

**Você não vai editar nenhum arquivo nesta tarefa.**

Sem escrever, criar, remover ou renomear. **Sem `npm install`, sem `npm audit fix`, sem tocar em `package-lock.json`.** Sem branch, sem commit. Permitido: **ler arquivo, listar diretório, buscar no código.**

**Se você editar qualquer arquivo, a tarefa falhou.** Um diff nesta rodada é erro, não entrega.

As instruções de correção existem, estão comigo, e você recebe depois — só para o que confirmar. Não peça. Não deduza. Não escreva.

## O repo

**Mayra AI Sales** (`atendente`): SaaS multi-tenant de atendente de vendas com IA via WhatsApp.

- `/server` — Node.js + Express + TypeScript · `/client` — React + Vite PWA
- PostgreSQL (Neon) com Row-Level Security · Cloudflare R2 · Socket.io
- Backend no Render, frontend na Vercel
- WhatsApp: Z-API (padrão) e Evolution API, roteamento por token (`/webhook/whatsapp/:webhookToken`) + rota legada
- IA com failover (Anthropic / OpenAI-compatível / Gemini)

Uma auditoria externa apontou problemas com arquivo e linha. **O código mudou desde então — as linhas citadas estão desatualizadas.**

## Formato — um bloco por item, exatamente assim

```
### Item N — <título>
Arquivo alegado : <caminho:linha da auditoria>
Arquivo real    : <onde você de fato achou, ou "não existe">
Status          : CONFIRMADO | PARCIALMENTE CONFIRMADO | NÃO CONFIRMADO | ARQUIVO NÃO EXISTE

Evidência (colada do arquivo, com números de linha reais):
```ts
  12 |  const X = ...
```

Análise: <2 a 4 frases.>
```

### Regras do relatório

1. **Evidência colada é obrigatória**, com números de linha reais. Não parafraseie. **Se você não consegue colar as linhas, você não leu o arquivo — o status é `ARQUIVO NÃO EXISTE`, não `CONFIRMADO`.**
2. **As linhas da auditoria estão velhas.** Reporte onde você **de fato** achou. Procure o arquivo inteiro antes de dar `NÃO CONFIRMADO`.
3. **`NÃO CONFIRMADO` é resultado válido e desejável.** Não force confirmação pra parecer produtivo.
4. **Arquivo não existe? Diga.** Não deduza pelo nome.
5. Um item por vez, na ordem 4 → 5 → 6.
6. Terminou os três? **Pare.** Não proponha plano de correção.

---

## Item 4 — Rota /media com fallback sem tenant 🟠

**Arquivos:** `server/src/controllers/media.controller.ts`, `server/src/db/queries/audios.ts` (função `getAudioBinary`), `server/src/db/queries/media_files.ts` (função `getMediaFile`)

**Alegação:** quando a URL **não** traz o token `?t=`, a consulta roda **sem filtro de `tenant_id`** (fallback legado), servindo mídia de qualquer empresa pra quem tiver o UUID.

**Checar:**
- o fallback sem tenant existe?
- como o controller decide entre o caminho com token e o sem?
- já existe env controlando isso?
- as queries rodam sob RLS? (atenção ao `runWithTenant` — se a rota é pública e não abre contexto de tenant, o RLS pode estar sendo contornado ou pode estar bloqueando tudo)

**Cole:** o trecho do controller que decide o caminho, **e** as duas queries no ponto onde o `tenant_id` entra (ou não entra).

**Contagem de URLs legadas** — saída real do banco, já rodada:

```
<<< COLE AQUI a saída do comando 2 (SQL) >>>
```

Use esses números na sua análise. **Não estime, não recalcule, não questione** — é a saída real. Se o bloco vier vazio, escreva "contagem não fornecida" e siga.

## Item 5 — Webhook legado aberto sem token 🟠

**Arquivo:** `server/src/controllers/webhook.controller.ts`

**Alegação:** a rota legada (a que **não** tem `:webhookToken`) só valida `WEBHOOK_VERIFY_TOKEN` **se a env estiver definida**. Sem a env, qualquer POST injeta mensagem no tenant padrão — abuso de custo de IA, e é também o vetor de entrada do Item 2.

**Checar:**
- a rota legada ainda existe?
- a validação ainda é condicional à *existência* da env?
- existe diferença de comportamento entre dev e produção (`env.isProd`)?
- qual tenant recebe a mensagem quando não há token?

**Cole:** o registro da rota legada, o handler, e a condicional da env.

## Item 6 — Dependências vulneráveis 🟠

**Alegação:** `npm audit` no `/server` acusa `ws` 8.0.0–8.20.1 (DoS por exaustão de memória, via `engine.io` / `socket.io-adapter`) e `form-data` (CRLF injection) — 4 high, 1 low.

**NÃO rode nada.** A saída real está abaixo:

```json
<<< COLE AQUI a saída do comando 1 (npm audit --json) >>>
```

```
<<< COLE AQUI a versão do multer >>>
```

**Sua tarefa neste item é ler a saída acima**, não gerá-la. **Se os blocos vierem vazios** (Bruno esqueceu de colar), escreva `Status: NÃO VERIFICÁVEL — saída de audit não fornecida` e siga para o próximo item. **Não rode `npm audit` você mesmo pra preencher.** Com a saída presente, compare com a alegação e reporte:
- as contagens por severidade batem com "4 high, 1 low"?
- `ws` e `form-data` aparecem? Em que versão, e por qual caminho de dependência?
- apareceu algo que a auditoria não citou?
- o `multer` é 1.x?

**Cole:** os pacotes e severidades extraídos da saída — não o JSON inteiro de novo.

---

## Achados extras

Algo **grave** nestes arquivos que não está na lista? Seção final `## Achados extras`, com arquivo, linha e evidência colada. Sem corrigir. Não infle.

## Fechamento obrigatório

```
## Resumo — rodada 2/3
Item 4: <STATUS>
Item 5: <STATUS>
Item 6: <STATUS>

Arquivos editados nesta rodada: NENHUM
```

### Confira antes de enviar

- [ ] Os 3 blocos preenchidos, um por item
- [ ] Evidência **colada** com número de linha real — nenhuma parafraseada
- [ ] Item 6: você **leu** a saída fornecida, não rodou `npm audit` você mesmo
- [ ] **`package-lock.json` intocado**
- [ ] **Nenhum arquivo foi editado**
- [ ] Você não propôs nenhuma correção

Pare aqui. Eu leio, e mando a rodada 3.
