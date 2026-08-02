# Mayra AI Sales — Correção B2: Fase 2 (abstração de provider de WhatsApp)

> **Sessão nova, modo Agent.** Só comece depois da Fase 1 (B1) mergeada e verde. Esta fase **não conserta bug** — é arquitetura pra permitir adicionar a Meta Cloud API (oficial) sem tocar no resto. Se a Meta Cloud não for prioridade agora, esta fase pode esperar; os itens 8 e 9 da Fase 3 não dependem dela (só o item 7 encosta, de leve).

## Não é reescrita — é evolução

**Estado atual (verificado):** já existe normalização parcial em `server/src/services/whatsapp.service.ts` — `parseInbound`, `parseStatusUpdate`, `getTenantWhatsapp`, tipo `NormalizedInbound` — em cima de `zapi.service.ts` e `evolution.service.ts`.

> **Não jogue isso fora. Evolua a partir do que existe.** Se você se pegar reescrevendo `zapi.service.ts` do zero, parou de evoluir e começou a reescrever — pare e reavalie.

## Regras da fase

- Um commit atômico por passo lógico, `feat(whatsapp): ...` em pt-BR.
- `npm run typecheck` + build verdes ao final.
- **Nenhuma regressão de envio/recebimento.** Z-API e Evolution têm que continuar funcionando idênticos. Se não há testes, descreva o teste manual que você fez (enviar texto, receber texto, enviar áudio, receber imagem) em cada provider.
- Isolamento multi-tenant intocado.

## Passos

### 1. Interface formal `WhatsAppProvider`

Defina a interface TypeScript com **o contrato que o mapeamento do código revelar que é usado hoje** — não invente métodos. No mínimo:
- envio de texto
- envio de áudio (PTT / voice note)
- envio de imagem
- `parseInbound`
- `parseStatusUpdate`
- status de conexão

Refatore `zapi.service.ts` e `evolution.service.ts` pra classes/módulos que **implementam** essa interface. O comportamento não muda; só ganha forma.

### 2. Formato neutro consolidado

`NormalizedInbound` vira o **único** formato que o webhook/pipeline consome. Campos: `providerMessageId`, `fromMe`, `type`, `text`, `mediaUrl`, `mediaMime`, `caption`, `timestamp`, `raw`.

> Ponte com a Fase 3: o item 7 (`fromMe`) depende de `NormalizedInbound.fromMe` e `.providerMessageId` estarem sólidos aqui. Garanta que os dois estão preenchidos corretamente pelos **dois** providers antes de fechar esta fase.

### 3. Esqueleto `MetaCloudProvider`

Mesma interface. Autenticação (Bearer + `phone_number_id`), endpoints do Graph API esboçados. Métodos podem lançar `NotImplementedError`.

> **Se algum método da interface não for implementável na Cloud API, ajuste a interface AGORA e reporte.** Melhor descobrir a incompatibilidade com um esqueleto do que depois de escrever o provider inteiro. Ex.: a Cloud API não expõe "status de conexão" do mesmo jeito que Z-API — se for o caso, a interface tem que acomodar isso.

### 4. Factory por tenant

`whatsapp_connections` já tem coluna `provider`. Garanta que `metacloud` (ou o nome escolhido) seja aceito por:
- o tipo `WhatsappProviderName`
- a validação
- a factory `getTenantWhatsapp`

Migration se o check/enum da coluna precisar do valor novo — padrão numerado, idempotente.

### 5. Verificação final

`grep -rn "z-api.io"` e chamadas HTTP diretas de WhatsApp devem aparecer **só dentro dos providers** (e testes/config). Se aparecer no controller ou no pipeline, a abstração vazou — conserte.

---

## Ao terminar

- `npm run typecheck` + build — cole a saída.
- Relatório: interface final, o que cada provider implementa, o que o `MetaCloudProvider` deixou como `NotImplementedError`, e **se você precisou ajustar a interface** por causa da Cloud API.
- Branch + PR. Não empurre no `main`.
- Pare. Fase 3 é o próximo prompt.

---

# ✅ verificado — Fase 2 executada

Branch `fix/auditoria-b1-b2-b3`. Nada no `main`, nada deployado.

| Passo | Resultado |
|---|---|
| 1 — Interface `WhatsAppProvider` | ✅ executado |
| 2 — `NormalizedInbound` consolidado | ✅ executado |
| 3 — Esqueleto `MetaCloudProvider` | ✅ executado |
| 4 — Factory por tenant + migration | ✅ executado |
| 5 — Verificação de vazamento | ✅ executado |

**Interface final** (`server/src/services/whatsapp/types.ts`), com o contrato que o código já usava — nada inventado: `sendText`, `sendAudio`, `sendImage`, `sendImages`, `markAsRead`, `getConnectionStatus`.

`parseInbound` e `parseStatusUpdate` **ficaram fora da interface de instância**, de propósito: hoje eles são chamados no webhook antes de existir uma conexão resolvida, sobre o payload cru. Continuam funções de módulo em `whatsapp.service.ts`, uma por provedor. Forçá-los para dentro da interface exigiria reescrever o roteamento do webhook — que é exatamente o que o prompt mandou não fazer.

`zapi.service.ts` e `evolution.service.ts` **não** viraram classes. A conformidade com a interface é garantida estruturalmente pelo TypeScript no facade (`TenantWhatsapp extends WhatsAppProvider`): se um provedor perder um método ou mudar assinatura, o build quebra. Foi evolução em cima do que existia, sem reescrita.

**`NormalizedInbound`** é o único formato que o pipeline consome, com `providerMessageId`, `fromMe`, `type`, `text`, `mediaUrl`, `mediaMime`, `caption`, `timestamp` e `raw`. O campo antigo `messageId` foi renomeado para `providerMessageId` em todos os pontos de uso. Os **dois** provedores preenchem `fromMe` e `providerMessageId` — é o que a Fase 3 item 7 consome.

**`MetaCloudProvider`** (`whatsapp/metacloud.service.ts`): auth Bearer + `phone_number_id`, URL do Graph montada por `messagesUrl()` (default `v21.0`). Lançam `NotImplementedError`: `sendText`, `sendAudio`, `sendImage`, `sendImages`, `markAsRead`.

**Ajuste de interface por causa da Cloud API — sim, houve um:** `getConnectionStatus` não podia continuar significando "celular pareado". A Cloud API não expõe isso; quem gerencia o número é a Meta. O retorno virou `ProviderStatus { ok, detail }`, com `detail` textual — na Z-API descreve o pareamento, no Meta Cloud responde "configurada, pareamento N/A". Sem esse ajuste o painel mostraria "desconectado" para um número Cloud perfeitamente funcional.

**Factory:** `WhatsappProviderName` aceita `'metacloud'`, os segredos ganharam `accessToken` e `phoneNumberId`, e `getTenantWhatsapp` monta o provider. Migration **021** recria o CHECK da coluna `provider` incluindo o valor novo (idempotente).

**Vazamento:** `z-api.io` aparece só em `config/env.ts` (default), `zapi.service.ts` e no facade `whatsapp.service.ts` (constante de base URL). `graph.facebook.com` só em `metacloud.service.ts`. Nenhuma chamada HTTP de WhatsApp no controller ou no pipeline.

**Teste manual — não executado.** Não há suíte de testes e eu não tenho número/instância ativa aqui. Antes de mergear, valide em Z-API e Evolution: enviar texto, receber texto, enviar áudio, receber imagem. O risco concreto é a renomeação `messageId` → `providerMessageId`; o typecheck cobre as referências, mas o caminho de rede não foi exercitado.

`npm run typecheck` e `npm run build` verdes.
