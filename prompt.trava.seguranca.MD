# Prompt de implementação — Trava de segurança (modo inbound-only) — `atendente`

> Cole no Cursor/Opus. Regra da fase Z-API: com `SAFE_MODE` ligada, o sistema **só responde quem chama** — nunca inicia conversa. Business-initiated (template, opt-in, reengajamento) fica **reservado e desativado**, pra voltar só na fase Cloud.

---

## Resumo pra ler antes de rodar

Alavanca mestre `SAFE_MODE`:

- **LIGADA (padrão — reativo puro):** o atendente só envia como **resposta a uma mensagem do cliente**. Não inicia conversa, não reengaja, não faz follow-up proativo, não dispara. Qualquer tentativa de envio proativo é **bloqueada e me avisa**. O reativo — coração do produto — continua 100%.
- **DESLIGADA (risco assumido):** bypass total, **sem aviso por mensagem**, faço tudo. O aviso vira responsabilidade do **app** (confirmação ao desligar + banner fixo).

**Por que assim:** iniciar/reenviar pra quem não engaja é o padrão que bane. "Só falo quando me chamam" **elimina esse padrão na estrutura** — não sobra brecha pra cometer o erro sem querer.

**Business-initiated não foi apagado, foi desligado.** Iniciar/reabrir conversa (que no Meta exige template + opt-in + janela de 24h) volta na **fase Cloud**, com as regras de verdade. Na fase Z-API fica reservado e off.

---

## Contexto e arquitetura

- Repo: `atendente` — Node.js/TypeScript/Express, PostgreSQL (RLS), Socket.IO, provedor atual Z-API.
- **Ponto único de envio:** todo envio passa por um módulo de saída. A trava roda nesse módulo. Se houver chamadas de envio espalhadas, refatorar — o bloqueio precisa ser inescapável.
- **Abstração de provedor** mantida pra migração futura:

```ts
interface MessageProvider {
  sendFreeform(to: string, text: string): Promise<SendResult>;
  // sendTemplate(...) — reservado pra fase Cloud, não usar agora
  capabilities: { businessInitiated: boolean };
}
```

- `ZapiProvider` agora (`businessInitiated:false`); `CloudProvider` depois (`businessInitiated:true`).

---

## Flags de configuração

| Flag | Default | O que faz |
|---|---|---|
| `SAFE_MODE` | `true` | Alavanca mestre. Ligada = reativo puro (só responde quem chama). Desligada = bypass total, sem aviso por mensagem (só banner do app). |
| `businessInitiatedEnabled` | `false` | **Hard-off na fase Z-API.** Reservado pra Cloud — aí entram template aprovado, opt-in e janela de 24h. **Não** expor como toggle casual de UI. |

---

## `SAFE_MODE = true` — reativo puro

Todo envio declara um `sendType`:

- **`reactive`** — gerado no **tratamento imediato de uma mensagem recebida** do contato (a resposta do atendente àquele inbound, podendo ser 1 ou mais balões enviados na sequência daquela resposta). Carrega `triggeringInboundId` (o id do inbound que disparou). **Permitido.**
- **`proactive`** — qualquer envio **não** disparado por um inbound recém-chegado: agendado, timer, cron, follow-up, reengajamento, campanha, blast, ou "cutucar" no meio da conversa quem parou de responder. **Bloqueado** com `SAFE_MODE` ligada.

**Regra única:** o atendente só fala quando o cliente **acabou de falar**. Sem inbound novo pra responder, não há envio.

**Ao bloquear:** log estruturado (`sendType`, `contactId`, timestamp) + **notificação ao operador** em texto claro. Ex.: *"Modo inbound-only: não inicio conversa, só respondo quem me chama."*

---

## `SAFE_MODE = false` — risco assumido

- Bypass total: `proactive` liberado, incluindo blast. **Sem aviso por mensagem.**
- **UX no app (não no backend):** ao desligar, confirmação única ("sem a trava o sistema não impede nenhum envio, inclusive os que causam ban; você assume o risco") + **banner persistente** "Modo seguro DESLIGADO".
- Backend expõe o estado do `SAFE_MODE` (endpoint/config + evento Socket.IO) pro app renderizar banner e confirmação.

---

## Reservado pra fase Cloud (desativado agora)

Só quando `businessInitiatedEnabled` for ligado, **no Cloud**, e como **módulo separado**:
- Reabrir conversa **fora da janela de 24h** → exige **template aprovado pela Meta**.
- Mensagem de **marketing** → exige **opt-in** registrado.
- Vale o classificador de **janela de 24h** (texto livre dentro; template fora).

Nada disso roda na fase Z-API. Construir desligado, pra plugar no Cloud sem mexer no resto.

---

## Pré-requisito

- Inbound tem que chegar ao handler pra o atendente responder (webhook funcionando).
- Envio `reactive` carrega `triggeringInboundId` — é o que distingue reativo de proativo. É a base de toda a trava.

---

## Plano de teste

Com `SAFE_MODE = true`:

| Cenário | Esperado |
|---|---|
| Cliente manda mensagem, atendente responde (1+ balões) | **ENVIA** (`reactive`) |
| Timer/cron tenta mandar follow-up | **BLOQUEIA** (`proactive`) |
| Código tenta reengajar quem sumiu | **BLOQUEIA** |
| Tentativa de blast/lista | **BLOQUEIA** |
| Atendente tenta "cutucar" quem não respondeu no meio da conversa | **BLOQUEIA** (proativo, sem inbound novo) |

Com `SAFE_MODE = false`:

| Cenário | Esperado |
|---|---|
| Qualquer envio proativo | **ENVIA** sem aviso |
| App | Mostra **banner de modo seguro desligado** |
| Ação de desligar | App pede **confirmação** antes |
| Cliente manda mensagem, atendente responde | **ENVIA** (reativo, como sempre) |

## Critérios de aceite

- [x] Ligada: nenhum envio `proactive` sai; só `reactive` passa.
- [x] Nenhum caminho (timer, cron, endpoint, loop) consegue iniciar conversa com a trava ligada.
- [x] Bloqueios notificam o operador.
- [x] Desligada: bypass total, sem aviso por mensagem, banner + confirmação no app.
- [x] Business-initiated existe só como módulo **desativado**, reservado pro Cloud.
- [x] Todo envio `reactive` carrega `triggeringInboundId`.
- [x] Reativo nunca é bloqueado, nos dois estados.