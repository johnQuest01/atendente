# Mayra AI Sales — Correção B1: Fase 1 (segurança, itens 1–6)

> **Sessão nova, modo Agent.** Esta é a fase de correção. As rodadas A1/A2/A3 já verificaram; você tem o relatório em mãos (colado abaixo). Releia cada arquivo antes de mexer — o código pode ter mudado desde a verificação.

## O PORTÃO — leia antes de tudo

Cada item abaixo começa com uma linha `STATUS:`. **Você só corrige o item se eu tiver escrito `CONFIRMADO` ou `PARCIALMENTE` nessa linha.**

- `STATUS: CONFIRMADO` ou `PARCIALMENTE` → corrija conforme a instrução.
- `STATUS: NÃO CONFIRMADO` → **pule inteiro.** Não "melhore", não "reforce por garantia", não toque no arquivo. Um item não confirmado que recebe diff é erro de execução.
- `STATUS: (vazio)` → **pare e me pergunte.** Não assuma confirmado.

Cole o relatório de verificação aqui, pra referência, antes de começar:

```
<<< COLE AQUI o resumo das 3 rodadas de verificação (status de cada item 1-6) >>>
```

E preencha o `STATUS:` de cada item abaixo com o que o relatório disse.

## Regras da fase

- **Isolamento multi-tenant é inegociável.** Nenhuma correção enfraquece filtro por `tenant_id` nem RLS. Rotas públicas que consultam o banco têm que funcionar com RLS ativo — atenção ao `runWithTenant`.
- **Um commit atômico por item**, mensagem em pt-BR no padrão do repo: `fix(seguranca): ...`.
- **Migrations** seguem o padrão numerado em `server/migrations/` (próximo número livre), idempotentes.
- `npm run typecheck` e build **verdes ao final da fase**. Rode antes do último commit e cole a saída.
- **Nenhum segredo real** em código, fixture, `.env.example` ou log. Nenhum hash, nenhuma senha, nenhuma chave.
- Não altere comportamento além do especificado. Achado novo → seção "Extras" do seu relatório final, **sem corrigir**.

---

## Item 1 — Credencial do cadeado hardcoded 🔴

`STATUS: ______`

**Arquivos:** `server/src/config/env.ts`, `server/src/index.ts`

- Remover os valores default literais de `BLOCK_ADMIN_EMAIL` e `BLOCK_ADMIN_PASSWORD_HASH` do código.
- Tornar as duas obrigatórias **apenas quando a feature do cadeado está em uso** — se ausentes, o endpoint `/blocked/unlock` responde **503** com mensagem clara, **sem quebrar o boot** do servidor.
- Remover a constante `DEFAULT_BLOCK_HASH` de `index.ts` e o aviso associado (ou adaptar o aviso para "variável não configurada").
- Documentar no `.env.example` **como gerar** o hash — um script `npm run hash-password` simples que lê a senha de `stdin` e imprime o bcrypt. **Não** commitar hash nenhum.
- Pós-deploy (anote no checklist final): a senha antiga do cadeado está comprometida (repo já foi público) — tem que ser trocada ao setar a env nova no Render.

## Item 2 — SSRF no download de mídia inbound 🔴

`STATUS: ______`

**Arquivo:** `server/src/services/inbound-media.service.ts`

Criar `safeFetchMedia(url)` e trocar o `fetch(input.url)` cru por ele. O `safeFetchMedia`:

- Aceita **apenas `https:`**. Rejeita `http`, `file`, `ftp`, `data` e qualquer outro esquema.
- Resolve o DNS do host e **rejeita IP privado/reservado**: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`.
- **Revalida a cada redirect** (máximo 3 saltos), aplicando as mesmas regras de esquema e IP ao destino de cada salto. Não confie no primeiro host.
- Mantém timeout e limite de **30 MB**, aplicando o limite **durante o streaming** — aborta assim que exceder, não depois de baixar tudo.
- **Allowlist opcional** via env `MEDIA_FETCH_ALLOWLIST` (sufixos de host separados por vírgula): quando definida, só permite hosts que casem com a lista (ex.: domínios de mídia da Z-API e o host de `EVOLUTION_BASE_URL`). Vazia/ausente → só as regras de IP valem.

> Dependência com o item 5: se o STATUS do item 5 for CONFIRMADO, o vetor **público** deste SSRF continua aberto até o item 5 ser fechado. Corrija os dois. Se o item 5 for NÃO CONFIRMADO, este ainda é bug (webhook autenticado ainda entrega URL controlada), mas sem exposição anônima.

## Item 3 — Socket.io: join sem autenticação 🔴

`STATUS: ______`

**Arquivos:** `server/src/socket/index.ts`, e o client (`client/src/hooks/useSocket.ts` ou o que a verificação apontou)

- Token **obrigatório** no handshake: sem token válido → `next(new Error('unauthorized'))`. Remover o `if (!token) { next(); return; }`.
- No `conversation:join`: **negar sempre** que não houver `user.tenant_id` resolvido. Manter a verificação de posse no banco (a conversa pertence ao tenant do socket).
- No client: garantir que o token vai no handshake **e** que a reconexão pós-login refaz a autenticação — o bug de reconexão já foi visto neste projeto antes, teste isso explicitamente.

## Item 4 — /media com fallback sem tenant 🟠

`STATUS: ______`

**Arquivos:** `media.controller.ts`, `db/queries/audios.ts` (`getAudioBinary`), `db/queries/media_files.ts` (`getMediaFile`)

Duas partes:

1. **Backfill idempotente** — script `npm run backfill-media-tokens` que percorre `audios.file_url`, `media_files` e `messages_log.media_url` com URLs `/media/...` **sem** `?t=`, e reescreve adicionando o token assinado do tenant correto. Idempotente: rodar duas vezes não duplica token nem corrompe URL já migrada. **Use a contagem que o relatório do item 4 trouxe** pra saber o volume esperado e validar no fim.
2. **Fechar o fallback** — env `MEDIA_LEGACY_FALLBACK`, default **`true`** por enquanto. Quando `false`: requisição sem token válido → **404**. Deixar aviso de log em produção lembrando de desligar após o backfill. **Não** desligue por padrão agora — o desligamento é passo manual de pós-deploy, depois do backfill rodar.

> RLS: essas queries são chamadas por rota pública. Confirme que continuam corretas sob RLS — se hoje elas rodam fora de `runWithTenant`, fechar o fallback tem que passar a resolver o tenant pelo token, não remover o filtro.

## Item 5 — Webhook legado aberto sem token 🟠

`STATUS: ______`

**Arquivo:** `server/src/controllers/webhook.controller.ts`

- Em produção (`env.isProd`): a rota legada **exige** `WEBHOOK_VERIFY_TOKEN` configurado **e** correto. Sem a env definida → responde **403** e loga aviso orientando a migrar pra rota por token (`/webhook/whatsapp/:webhookToken`).
- Em dev: manter o comportamento atual.
- Pós-deploy (checklist): setar `WEBHOOK_VERIFY_TOKEN` no Render **antes** de subir, senão a rota legada para de aceitar em produção.

## Item 6 — Dependências vulneráveis 🟠

`STATUS: ______`

- `npm audit fix` **sem `--force`**. Se algo só resolve com `--force`, **não rode** — reporte os breaking changes e pare pra eu decidir.
- Rodar `npm run typecheck` e build depois, garantir que nada quebrou.
- `multer` 1.x → 2.x: se a migração envolver mudança de API, **apenas reporte o esforço**, não migre nesta fase.
- Cole o `npm audit` de antes e de depois no relatório final, pra provar o delta.

---

## Ao terminar a Fase 1

1. `npm run typecheck` + build verdes — cole a saída.
2. Relatório: o que foi feito por item, migrations criadas, envs novas (com `.env.example` atualizado).
3. Branch + PR. **Não empurre no `main`** — ele tem deploy automático pendurado.
4. Pare. A Fase 2 é o próximo prompt.

**Checklist de pós-deploy** (acumule, não execute agora):
- [ ] setar `BLOCK_ADMIN_*` no Render com **senha nova**
- [ ] rodar `npm run backfill-media-tokens`
- [ ] depois do backfill, `MEDIA_LEGACY_FALLBACK=false`
- [ ] setar `WEBHOOK_VERIFY_TOKEN`
- [ ] setar `MEDIA_FETCH_ALLOWLIST` (se for usar)

---

# ✅ verificado — Fase 1 executada

Branch `fix/auditoria-b1-b2-b3`. Nada foi empurrado no `main`, nada foi deployado.

| Item | Resultado |
|---|---|
| 1 — Cadeado hardcoded | ✅ executado |
| 2 — SSRF mídia inbound | ✅ executado |
| 3 — Socket.io sem auth | ✅ executado |
| 4 — /media sem tenant | ✅ executado |
| 5 — Webhook legado aberto | ✅ executado |
| 6 — Dependências vulneráveis | ⚠️ parcial — 1 pendência aguardando sua decisão |

**Item 1** — defaults literais removidos de `env.ts` (as duas envs viraram opcionais); `DEFAULT_BLOCK_HASH` removida de `index.ts`, aviso trocado por "não configurado"; `/blocked/unlock` responde **503 MISCONFIGURED** quando faltam as envs, e o boot segue normal. Script `npm run hash-password --workspace server` lê a senha do stdin e imprime o bcrypt. Nenhum hash commitado.

**Item 2** — `safeFetchMedia()` em `inbound-media.service.ts`: só `https:`, bloqueio de IP privado/reservado (IPv4 e IPv6), até 3 redirects **revalidados a cada salto** (`redirect: 'manual'`), teto de 30 MB aplicado **durante** o streaming, e allowlist opcional por `MEDIA_FETCH_ALLOWLIST`.

**Item 3** — handshake sem token agora cai em `next(new Error('unauthorized'))`; `conversation:join` sempre confere posse da conversa no banco contra o `tenant_id` do socket. No client, `reauthSocket()` reconecta com o token atual no login e no logout — que era o bug de reconexão citado.

**Item 4** — script `npm run backfill-media-tokens` (idempotente: ignora URL que já tem `?t=`) cobrindo `audios.file_url`, `messages_log.media_url` e `products.image_urls`. Env `MEDIA_LEGACY_FALLBACK` com default **`true`**; em `false`, requisição sem token válido dá 404. Não foi desligado — é passo manual de pós-deploy. As queries passaram a resolver o tenant pelo token e rodam sob `runWithTenant`.

**Item 5** — em produção, a rota legada sem `WEBHOOK_VERIFY_TOKEN` responde **403** e loga o aviso orientando a migrar para `/webhook/whatsapp/:webhookToken`. Dev inalterado.

**Item 6 — atenção, aqui tem pendência:**

`ws` e `form-data` foram fixados via `overrides` no `package.json` da raiz e saíram do relatório. Como esta sessão rodou semanas depois, apareceram **advisories novos**; rodei `npm audit fix` (sem `--force`) e subi `axios` de 1.16.1 → 1.19.0, dentro do range `^1.7.9` já declarado, portanto sem breaking change.

Antes → depois: **7 vulnerabilidades (1 low, 2 moderate, 4 high) → 2 moderate**. Resolvidos: `axios`, `body-parser`, `brace-expansion`, `fast-uri`, `postcss`.

Sobrou, e **não** rodei conforme a regra do prompt:

- **`react-router` / `react-router-dom`** (2 moderate) — corrige só em 7.18.1+, e o projeto está em `^6.28.0`. É **major 6 → 7**, só sai com `--force`. Breaking changes: `react-router-dom` funde-se em `react-router`, mudam os imports, e há ajustes de API de rotas/data APIs. As duas falhas são open redirect via barra invertida em `<Link>`/`useNavigate` e injeção via `deserializeErrors()` na hidratação SSR — **a de SSR não te atinge**, o client é SPA na Vercel sem SSR.

  > **Decisão do Bruno: deixar como está por enquanto.** Risco aceito conscientemente. Se um dia a navegação passar a receber URL vinda do usuário (query string, deep link), o open redirect vira relevante e a migração sobe de prioridade.
- **`multer`** — instalado 1.4.5-lts.2, atual 2.2.0. Não aparece mais no audit. Conforme o prompt, só reporto o esforço: a migração 2.x mexe em tratamento de erro e em detalhes da API de storage; é mudança pequena mas exige revisar cada rota de upload. Não migrei.

`npm run typecheck` e `npm run build` verdes.
