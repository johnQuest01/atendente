# Registro — Trava de envio segura (Fluxo C) aplicada

**Data:** 2026-08-16
**Origem:** `upgrade.1.MD` (aplicado por Opus 4.8, em par com o Bruno)
**Status:** `npm run typecheck` passa (server + client). **Ainda não deployado no Fly.io.**

---

## O que essa trava resolve

Antes, quando a IA **dizia** que tinha enviado mas nenhuma tool disparava, o código
pegava o **texto/raciocínio da própria IA** e mandava pro contato (`fulfillMissingOwnerSend`
com `aiText`). Foi isso que vazou comentário do modelo ("é arriscado…") pra um contato real.

Agora o envio a contato só sai por um **caminho único e gated**, e **a decisão de
autorizar é do código, não do modelo**.

---

## Fases aplicadas

### Fase 1 — `sendType: 'owner_authorized'`
- `server/src/services/outbound/types.ts` — novo tipo `owner_authorized`.
- `server/src/services/outbound/safe-mode.service.ts` — o gate libera **e audita**
  (`event: 'owner_authorized_send'`); `proactive` continua bloqueado sob SAFE_MODE.
- `server/src/services/owner-relay.service.ts` — `sendOwnerRelay` carimba `owner_authorized`.

### Fase 2 — Morte do force-send (o vazamento)
- Apagados de vez: `fulfillMissingOwnerSend`, `composeSendBody`, `extractQuotedOutbound`.
- Removido o bloco `shouldForceSend` em `owner-chat.service.ts`.
- Novos detectores puros (sem efeito colateral): `hasClearSendVerb`, `looksLikeDenyOutbound`.

### Fases 3 + 4 — Fluxo C: plano + confirmação única
- Novo arquivo `server/src/services/owner-pending.ts` — store de pendência in-memory
  (TTL 5 min, chave `tenant + dono + conexão`).
- `owner-actions.ts` — `enviar`/`agendar` **acumulam** no plano do turno (com dedup),
  em vez de disparar na hora.
- `owner-chat.service.ts` — no fim do turno:
  - **1 envio + verbo claro** (`manda/mande/envia/envie/diz/diga/fala/fale`) → envia direto;
  - senão (≥2 envios ou verbo não-claro) → **um plano, uma confirmação** (`sim`/`não`).
  - A confirmação é resolvida **antes de chamar o modelo**, de forma determinística
    (sem envio duplo, sem "sim" antigo disparando algo solto depois).
- **Só o corpo literal** (`mensagem`/`relay_body`) chega no dispatch — nunca texto do modelo.

### Fase 5 — Agendados carregam o carimbo
- Scheduler e handler já usam `sendOwnerRelay` → passam no gate por `owner_authorized`
  no horário. Plano confirmado com horário futuro vira `createReminder`.

### Fase 6 — Fora de escopo (intocado)
- Broadcast, `businessInitiated` (Z-API) e a whitelist fixa de verbos: **não mexidos**.

---

## Desvios em relação ao `upgrade.1.MD` (o repo tinha divergido)

1. **PROBLEMA 1 não existia** — o build já passava; não havia import quebrado.
2. `assistantClaimedCancel`/`assistantClaimedSave` **não foram movidos** pro owner-relay —
   já existiam e funcionavam localmente.
3. `agendar` entra no plano **só quando é envio único**; com recorrência mantém o caminho
   direto (senão a recorrência se perderia) — ainda gated por `owner_authorized`.
4. Adicionados **dedup no plano** + ajuste no system prompt, porque a tool agora responde
   `PLANEJADO` (antes o modelo procurava `OK — enviado` e re-chamava, o que duplicaria envios).

---

## Arquivos alterados por esta trava

- `server/src/services/outbound/types.ts`
- `server/src/services/outbound/safe-mode.service.ts`
- `server/src/services/owner-relay.service.ts`
- `server/src/services/owner-pending.ts` *(novo)*
- `server/src/services/ai/tools/owner-actions.ts`
- `server/src/services/owner-chat.service.ts`

## Como validar (SAFE_MODE = true)

Testar os cenários da tabela do `upgrade.1.MD`, principalmente:
- "manda boa noite pro Wender" → envia direto;
- "avisa o Wender" → pergunta antes; só envia no "sim";
- lote (Wender agora + João em 1 min) → um plano, uma confirmação;
- IA afirmar "mandei" sem chamar tool → não envia, corrige a resposta.

## Deploy

- **Servidor (Fly.io, app `mayra-api`):** `fly deploy` — **pendente**, rodar após testar.
- **Painel (Vercel):** sem mudança nesta trava (tudo é server-side).

OK
