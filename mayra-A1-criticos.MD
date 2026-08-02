# Mayra AI Sales — Verificação, rodada 1 de 3 🔴 CRÍTICOS

> **Sessão limpa.** Não continue conversa anterior. Esta rodada cobre só os itens **1, 2 e 3**. Os itens 4–9 vêm em outras rodadas — ignore-os completamente, mesmo que você tropece neles.
>
> **Modo recomendado: Ask (somente leitura).** Se estiver em Agent, a regra abaixo vale igual.
>
> **Ordem:** esta rodada e a rodada 3 não dependem de terminal nem de banco — pode rodar as duas primeiro. A rodada 2 exige que Bruno cole a saída de `npm audit` e uma contagem do Neon, então deixe-a pro momento em que estiver no PC. O plano de correção só precisa das três juntas no fim.

## A regra

**Você não vai editar nenhum arquivo nesta tarefa.**

Sem escrever, criar, remover ou renomear. Sem `npm install`, sem `npm audit fix`, sem branch, sem commit. Permitido: **ler arquivo, listar diretório, buscar no código.**

**Se você editar qualquer arquivo, a tarefa falhou** — por mais óbvia que a correção pareça. Um diff nesta rodada é erro, não entrega.

Achou o problema e a solução é trivial? Ótimo, é sinal de que a verificação foi bem. **Anote e siga.** As instruções de correção existem, estão comigo, e você recebe depois — só para o que confirmar. Não peça. Não deduza. Não escreva.

## O repo

**Mayra AI Sales** (`atendente`): SaaS multi-tenant de atendente de vendas com IA via WhatsApp.

- `/server` — Node.js + Express + TypeScript · `/client` — React + Vite PWA
- PostgreSQL (Neon) com Row-Level Security · Cloudflare R2 · Socket.io
- Backend no Render, frontend na Vercel
- WhatsApp: Z-API (padrão) e Evolution API, roteamento por token (`/webhook/whatsapp/:webhookToken`) + rota legada
- IA com failover (Anthropic / OpenAI-compatível / Gemini), chaves cifradas AES-256-GCM

Uma auditoria externa apontou problemas com arquivo e linha. **O código mudou desde então — as linhas citadas estão desatualizadas.** Sua tarefa é descobrir o que ainda é verdade.

## Formato — um bloco por item, exatamente assim

```
### Item N — <título>
Arquivo alegado : <caminho:linha da auditoria>
Arquivo real    : <onde você de fato achou, ou "não existe">
Status          : CONFIRMADO | PARCIALMENTE CONFIRMADO | NÃO CONFIRMADO | ARQUIVO NÃO EXISTE

Evidência (colada do arquivo, com números de linha reais):
```ts
  12 |  const X = ...
  13 |  ...
```

Análise: <2 a 4 frases. Se PARCIAL, o que difere. Se NÃO CONFIRMADO, o que está lá no lugar.>
```

### Regras do relatório

1. **Evidência colada é obrigatória**, com os números de linha reais. Não parafraseie, não reconstrua de memória, não escreva "o código faz X". Cole. **Se você não consegue colar as linhas, você não leu o arquivo — e o status é `ARQUIVO NÃO EXISTE`, não `CONFIRMADO`.**
2. **As linhas da auditoria estão velhas.** Reporte onde você **de fato** achou. Não está na linha citada? Procure o arquivo inteiro antes de dar `NÃO CONFIRMADO`.
3. **`NÃO CONFIRMADO` é resultado válido e desejável.** Significa que já foi corrigido, ou que a auditoria errou. Não force confirmação pra parecer produtivo.
4. **Arquivo não existe? Diga.** Não deduza o conteúdo pelo nome. Não descreva o que "provavelmente" tem lá.
5. Um item por vez, na ordem 1 → 2 → 3.
6. Terminou os três? **Pare.** Não proponha plano de correção.

---

## Item 1 — Credencial do cadeado hardcoded 🔴

**Arquivos:** `server/src/config/env.ts` e `server/src/index.ts`

**Alegação:** `BLOCK_ADMIN_EMAIL` tem default hardcoded `'bruno@adminalfa.com'` e `BLOCK_ADMIN_PASSWORD_HASH` tem um hash bcrypt default literal no código. Existe também uma constante `DEFAULT_BLOCK_HASH` em `index.ts`, com um aviso associado.

**Checar:** os defaults ainda estão literais? A constante `DEFAULT_BLOCK_HASH` existe? Onde as duas envs são lidas e onde são usadas (provável: endpoint `/blocked/unlock`)?

**Cole:** as linhas das duas envs, e a da constante se existir.

> ⚠️ **Não cole o hash completo.** Os 10 primeiros caracteres provam que é literal. Este repo já esteve público — não espalhe o resto.

## Item 2 — SSRF no download de mídia inbound 🔴

**Arquivo:** `server/src/services/inbound-media.service.ts`

**Alegação:** a função `downloadBytes` faz `fetch(input.url)` com URL vinda **crua do payload do webhook** — que é rota pública. Sem validação de esquema nem de IP de destino. Permite forçar o servidor a buscar endereços internos (metadata de nuvem, serviços internos) e servir o conteúdo de volta via `/media`.

**Checar, um por um:**
- existe validação de esquema (`https:` apenas)?
- existe bloqueio de IP privado/reservado (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`)?
- existe allowlist de host?
- existe seguimento de redirect? Se sim, o destino é revalidado a cada salto?
- o limite de 30 MB é aplicado **durante** o streaming, ou só depois de baixar tudo?

**Cole:** a função `downloadBytes` inteira. Se o chamador dela estiver **no mesmo arquivo**, cole também. Se estiver noutro arquivo (provável: um controller), **não abra esse arquivo agora** — apenas nomeie qual é e diga de qual campo do payload a URL parece vir, com base no parâmetro que `downloadBytes` recebe. O chamador é verificado a fundo na rodada 2.

## Item 3 — Socket.io: join em conversa sem autenticação 🔴

**Arquivos:** `server/src/socket/index.ts` e o client (`client/src/hooks/useSocket.ts` ou equivalente — procure se o caminho não bater)

**Alegação:** o middleware de handshake tem `if (!token) { next(); return; }` — token opcional. E no handler `conversation:join` a checagem de posse está dentro de `if (user?.tenant_id)`, então um socket sem token **pula a verificação** e entra na sala de qualquer conversa cujo UUID conheça.

**Checar:**
- o handshake ainda aceita conexão sem token?
- a checagem de posse ainda está condicionada a `user?.tenant_id`?
- o client envia o token no handshake?

**Cole:** o middleware do handshake, o handler `conversation:join`, e a linha do client que monta a conexão.

---

## Achados extras

Achou algo **grave** nestes três arquivos que não está na lista? Seção final `## Achados extras`, com arquivo, linha e evidência colada. Sem corrigir. Não infle — se não for grave, não vá.

## Fechamento obrigatório

```
## Resumo — rodada 1/3
Item 1: <STATUS>
Item 2: <STATUS>
Item 3: <STATUS>

Arquivos editados nesta rodada: NENHUM
```

### Confira antes de enviar

- [ ] Os 3 blocos estão preenchidos, um por item
- [ ] Cada um tem evidência **colada**, com número de linha real — nenhum parafraseado
- [ ] O hash do Item 1 está truncado em 10 caracteres
- [ ] **Nenhum arquivo foi editado**
- [ ] Você não propôs nenhuma correção

Pare aqui. Eu leio, e mando a rodada 2.
