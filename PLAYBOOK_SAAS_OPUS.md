# PLAYBOOK SAAS — Mayra AI Sales → Plataforma multi-empresa

> **Para quem é este documento:** instruções para o agente **Opus** executar, por fases,
> a transformação do Mayra AI Sales (hoje single-tenant, validado) em um **produto SaaS**
> vendável para outras empresas e micro-negócios: um atendente de WhatsApp **24h,
> humanizado, 100% funcional** que atende clientes, converte vendas, tira dúvidas,
> processa reembolsos/trocas e faz follow-up.
>
> **Como usar:** o Bruno dirá algo como *"Opus, execute a Fase X do PLAYBOOK"*. Ao receber
> a ordem, leia a fase correspondente inteira, crie um TODO com os itens da fase, e implemente
> com código real e funcional (TypeScript estrito, sem `any`, sem TODOs). NÃO comece nada
> deste playbook sem ordem explícita do Bruno.

---

## 0. Princípios e regras de execução (LER SEMPRE)

- **Não quebre o que funciona.** O sistema atual está validado. Toda mudança grande entra
  atrás de migrations aditivas e com retrocompatibilidade.
- **Cada fase termina com:** `npm run typecheck` + `npm run build` passando nos dois apps,
  e um resumo do que mudou + como testar.
- **Segurança primeiro:** isolamento de dados entre empresas (tenant) é inegociável.
- **Stack mantida:** React/Vite/TS, Express/TS, Neon Postgres, Socket.io, Anthropic, Z-API/Evolution.
- **Idioma:** código e UI em PT-BR; commits e docs em PT-BR.
- **Confirme antes de:** mudanças destrutivas, troca de provedor de infra, ou qualquer
  decisão de precificação/negócio. Para escolhas técnicas equivalentes, decida e siga.

---

## 1. Estado atual (baseline — já pronto)

- Monorepo `client/` + `server/` com npm workspaces.
- Banco Neon com 8 tabelas: `users, clients, conversations, messages_log, audios,
  text_scripts, products, keywords` + runner de migrations (`server/src/db/migrate.ts`).
- Auth JWT + bcrypt; middlewares de validação (Zod), auth, upload, erro centralizado.
- Orquestrador de IA no webhook: keyword-match → áudio/script/produto → fallback Claude.
- Facade de WhatsApp (`server/src/services/whatsapp.service.ts`) com **Z-API e Evolution**
  selecionáveis por `.env`.
- Painel PWA: Dashboard, Conversas (tempo real), Chat, Áudios (upload+gravação), Produtos,
  Scripts, Keywords, Configurações.

**Lacuna central para virar SaaS:** tudo hoje assume **uma única empresa**. Precisamos de
**multi-tenancy** (cada empresa = um tenant isolado, com seu número de WhatsApp, seus áudios,
produtos, scripts, usuários, faturamento e configurações de IA).

---

## FASE 1 — Multi-tenancy (fundação do SaaS)

**Objetivo:** isolar dados por empresa. Esta é a fase mais crítica.

### Modelo de dados
- [ ] Migration `009_create_tenants.sql`:
  ```sql
  CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(80) UNIQUE NOT NULL,           -- subdomínio/identificador
    status VARCHAR(20) DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','suspended','canceled')),
    plan VARCHAR(40) DEFAULT 'starter',
    settings JSONB DEFAULT '{}',                -- nome da loja, prompt custom, horários, etc.
    trial_ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- [ ] Migration `010_add_tenant_id.sql`: adicionar `tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE`
      em **todas** as tabelas de domínio (`users, clients, conversations, messages_log,
      audios, text_scripts, products, keywords`). Criar índice composto `(tenant_id, ...)`
      nos campos mais consultados (ex: `clients(tenant_id, phone)` UNIQUE).
- [ ] Backfill: criar 1 tenant "default" e atribuir os dados existentes a ele.

### Camada de acesso
- [ ] Adicionar `tenant_id` ao `JwtPayload` e ao `req.user` (tipos em `server/src/types`).
- [ ] **Regra de ouro:** TODA query de domínio recebe `tenantId` e filtra por ele.
      Criar helper/escopo para não esquecer (ex: funções de query passam a exigir `tenantId`
      como primeiro argumento). Revisar `server/src/db/queries/*`.
- [ ] Middleware `tenant.middleware.ts`: resolve o tenant a partir do JWT (e valida `status`).
- [ ] Webhook: resolver tenant pelo **número de WhatsApp de destino** (mapear instância/phone → tenant).

### Critérios de aceite
- [ ] Usuário do tenant A nunca vê dado do tenant B (testar com 2 tenants).
- [ ] Webhook roteia a mensagem para o tenant correto.
- [ ] `typecheck` + `build` ok.

---

## FASE 2 — Provisionamento de WhatsApp por tenant

**Objetivo:** cada empresa conecta o próprio número, sem você tocar em código.

- [ ] Tabela `whatsapp_instances` (tenant_id, provider, instance_id, token, client_token,
      phone, status, webhook_secret).
- [ ] Refatorar `whatsapp.service.ts` de "singleton por .env" para **resolver credenciais
      por tenant** (recebe `tenantId`/config em vez de ler `env` global). Manter a interface
      `sendText/sendAudio/sendImage/sendImages`.
- [ ] Tela no painel (admin do tenant): conectar instância, exibir QR code (Z-API/Evolution),
      status da conexão, botão "reconectar".
- [ ] Webhook único `/webhook/whatsapp/:tenantSlug` (ou identificação por `instance_id` no payload)
      com validação por `webhook_secret`.
- [ ] Onboarding: ao criar tenant, instruir/automatizar criação da instância.

### Critérios de aceite
- [ ] Dois tenants com números diferentes recebem/enviam isoladamente.

---

## FASE 3 — Capacidades de atendimento (o "produto")

**Objetivo:** entregar o que vende: vendas, dúvidas, reembolso/troca, follow-up.

- [ ] **Configuração de IA por tenant:** system prompt editável no painel (tom, nome da loja,
      políticas, formas de pagamento, prazos). Persistir em `tenants.settings` ou tabela própria.
- [ ] **Base de conhecimento / FAQ:** tabela `knowledge_base` (pergunta, resposta, keywords)
      + injeção no contexto do Claude (RAG simples por keyword/embedding).
- [ ] **Fluxos estruturados (intents):**
  - Venda: apresentar produto → preço → quebrar objeção → fechar/agendar follow-up.
  - Dúvida: responder via FAQ/produto, escalar para humano se incerto.
  - **Reembolso/Troca:** coletar nº do pedido, motivo, abrir um "ticket" e notificar a empresa;
    nunca prometer valores sem confirmação. Tabela `tickets` (tipo, status, payload).
  - Pós-venda/Follow-up: agendar mensagens (ver Fase 4).
- [ ] **Handoff humano:** botão "assumir conversa" pausa a IA; status `waiting`/`open` já existe.
      Adicionar flag `ai_paused` por conversa.
- [ ] **Tool use do Claude (opcional avançado):** function-calling para consultar produto,
      criar ticket, checar status de pedido. Implementar como ferramentas no `claude.service`.

### Critérios de aceite
- [ ] Demo end-to-end: cliente pergunta preço → recebe produto+preço; pede reembolso →
      abre ticket; dúvida fora do escopo → IA escala para humano.

---

## FASE 4 — Automação, agendamento e confiabilidade

- [ ] **Fila de mensagens** (evitar bloquear o webhook; reprocessar falhas). Começar simples
      (tabela `outbox` + worker) e evoluir se necessário.
- [ ] **Follow-up agendado:** tabela `scheduled_messages` + worker que dispara (ex: "passou 24h
      sem resposta"). Respeitar opt-out e janela de 24h do WhatsApp (usar templates quando fora).
- [ ] **Rate limiting / anti-ban:** atraso humanizado entre mensagens, limites por minuto.
- [ ] **Retry + idempotência** nos envios (já há `zapi_message_id`; usar para dedupe).
- [ ] **Observabilidade:** logs estruturados por tenant, métrica de entrega/leitura, alertas.

---

## FASE 5 — Billing, planos e ciclo de vida (monetização)

- [ ] Integração de pagamento (decidir com Bruno: **Stripe** internacional ou **Asaas/
      Pagar.me/Mercado Pago** para BR com PIX/boleto/cartão).
- [ ] Tabela `subscriptions` (tenant_id, plan, status, current_period_end, gateway_ids).
- [ ] **Planos sugeridos** (validar preços com Bruno):
  - *Starter*: 1 número, X conversas/mês, IA básica.
  - *Pro*: mais conversas, follow-up agendado, FAQ/RAG, múltiplos atendentes.
  - *Business*: vários números, white-label, API, prioridade.
- [ ] **Medição de uso:** contar conversas/mensagens/tokens de IA por tenant (limites por plano).
- [ ] **Trial + estados:** `trialing → active → past_due → suspended`. Bloquear envio quando
      `suspended`, mantendo dados.
- [ ] Webhooks do gateway → atualizar `subscriptions`/`tenants.status`.
- [ ] Portal de cobrança (trocar plano, cartão, ver faturas).

---

## FASE 6 — Onboarding self-service & UX de cliente

- [ ] **Cadastro self-service:** empresa cria conta → cria tenant → wizard de onboarding
      (dados da loja, conectar WhatsApp, importar produtos, definir prompt, gravar 1º áudio).
- [ ] **Landing page** de vendas do serviço (proposta de valor: atendente 24h que vende).
- [ ] **White-label opcional:** logo/cores por tenant; PWA com nome/ícone do cliente.
- [ ] **Templates prontos por segmento** (farmácia, moda, alimentação, serviços) com keywords,
      scripts e FAQ iniciais para acelerar o "tempo até o valor".
- [ ] Tela de **super-admin** (você) para gerenciar tenants, planos, suporte e impersonar.

---

## FASE 7 — Segurança, conformidade e produção

- [ ] **LGPD:** consentimento, política de privacidade, opt-out, exclusão de dados por titular,
      retenção configurável de conversas.
- [ ] **Criptografia de segredos** (tokens de WhatsApp por tenant) em repouso.
- [ ] **Hardening:** rate limit global, Helmet, CORS por tenant, rotação de JWT, refresh tokens,
      2FA opcional para admins.
- [ ] **Backups** do Neon + plano de restauração; migrations versionadas.
- [ ] **Deploy de produção:** definir host (ex: Railway/Render/Fly para o server, Vercel/Cloudflare
      Pages para o client) + storage real (S3/R2 — já há abstração em `storage.service.ts`) +
      domínio + TLS + CI/CD. Configurar `PUBLIC_BASE_URL` real.
- [ ] **Monitoramento:** uptime, erros (Sentry), custo de IA por tenant.

---

## FASE 8 — Go-to-market (apoio do Opus, sob demanda)

- [ ] Página de preços + comparativo de planos.
- [ ] Materiais: copy de vendas, roteiro de demo, FAQ comercial.
- [ ] Métricas de sucesso do cliente (conversas atendidas, vendas atribuídas, tempo de resposta)
      no Dashboard — virar argumento de retenção.
- [ ] Programa de indicação / trial guiado.

---

## Decisões pendentes (perguntar ao Bruno antes de executar)

1. **Gateway de pagamento:** Stripe vs Asaas/Pagar.me/Mercado Pago (PIX é importante no BR).
2. **Modelo de número de WhatsApp:** cada cliente traz o seu (BYO) ou você provisiona?
3. **Z-API vs Evolution como padrão do SaaS** (custo recorrente vs self-host/infra).
4. **Preços e limites por plano.**
5. **Hospedagem de produção** e orçamento de infra.
6. **White-label** já no MVP ou depois?

---

## Ordem recomendada de execução

`Fase 1 (multi-tenant)` → `Fase 2 (WhatsApp por tenant)` → `Fase 3 (capacidades)` →
`Fase 5 (billing)` → `Fase 6 (onboarding)` → `Fase 4 (automação/escala)` →
`Fase 7 (segurança/produção)` → `Fase 8 (GTM)`.

> Fases 1 e 2 são pré-requisito de tudo. Billing (5) pode vir antes da automação (4) para
> começar a faturar cedo com um MVP.

---

## Checklist de "Definition of Done" por fase (Opus segue sempre)

- [ ] Migrations aditivas e reversíveis quando possível.
- [ ] Isolamento por tenant verificado.
- [ ] `npm run typecheck` e `npm run build` verdes nos dois apps.
- [ ] Sem `any`, sem TODO no código, sem segredo hardcoded.
- [ ] Resumo final: o que mudou, como testar, riscos e próximos passos.
```
