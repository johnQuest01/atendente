# Mayra AI Sales — C1: pós-deploy e conexão do WhatsApp oficial

> Estado em 02/08/2026. A `main` recebeu 10 commits (auditoria B1/B2/B3 + conector Meta + convites/trial + lembretes) e foi empurrada — Render e Vercel publicaram, e as migrations 021→024 rodaram no Neon pelo `buildCommand`.
>
> **Contexto que motiva este documento:** a Z-API caiu por falta de pagamento. O caminho daqui é o **WhatsApp Oficial (Meta Cloud API)**, que já está implementado e esperando credenciais. Enquanto ninguém conectar um número, o sistema não recebe nem envia mensagem — o resto do painel funciona normal.

- API: `https://mayra-api.onrender.com`
- Repo: `johnQuest01/atendente` · branch `main`

---

## PARTE 1 — Conferir se o deploy subiu inteiro

1. **Render → mayra-api → Logs do último build.** Procure a saída das migrations. Devem aparecer aplicadas:
   - `021_whatsapp_provider_metacloud`
   - `022_human_pause_and_message_origin`
   - `023_tenant_invites_and_trial`
   - `024_reminders`
   Se alguma falhar, o build inteiro falha e o serviço fica na versão antiga — o sintoma é o painel não mostrar as novidades.

2. **Health:** `https://mayra-api.onrender.com/health` deve responder `{"status":"ok","db":true}`.

3. **Log de boot.** Deve aparecer `Agendador de lembretes iniciado`. Se não aparecer, o processo não subiu a versão nova.

4. **Avisos de segurança no boot** (são esperados até a Parte 3): menções a `BLOCK_ADMIN_*`, `WEBHOOK_VERIFY_TOKEN` e `MEDIA_LEGACY_FALLBACK`.

5. **Render → Environment:** confirme que `FRONTEND_URL` aponta para a URL do Vercel. Ela é usada em duas coisas: liberar CORS e **montar o link dos convites**. Se estiver vazia, o convite sai com a URL da API e não abre.

---

## PARTE 2 — Conectar o WhatsApp Oficial (prioridade)

### 2.1 Do lado da Meta

1. Acesse [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Criar app** → tipo **Empresa/Business**.
2. No app, adicione o produto **WhatsApp**.
3. Em **WhatsApp → API Setup** você recebe:
   - um **número de teste** da Meta,
   - um **phone number ID** (é esse que o painel pede),
   - um **token temporário**.

> ⚠️ **Dois limites do modo de teste que confundem muita gente:**
> - o token da tela de API Setup **expira em 24 horas**;
> - o número de teste só envia para **até 5 números** previamente cadastrados ali na mesma tela.
>
> Para testar de verdade, cadastre o seu celular nessa lista de destinatários. Para produção, siga o 2.2.

### 2.2 Token permanente (obrigatório para valer)

O token de 24h serve só para o primeiro teste. O definitivo sai assim:

1. **Business Settings** (business.facebook.com) → **Usuários → Usuários do sistema** → criar um usuário do sistema com papel de administrador.
2. **Adicionar ativos** → selecione o app do WhatsApp → conceda controle total.
3. **Gerar novo token** → escolha o app → marque as permissões **`whatsapp_business_messaging`** e **`whatsapp_business_management`** → validade **nunca expira**.
4. Copie o token (começa com `EAA...`). Ele só aparece uma vez.

Para usar seu número próprio em vez do de teste: **WhatsApp → API Setup → Adicionar número de telefone**, confirme por SMS/ligação e conclua a verificação do negócio.

### 2.3 Do lado do painel

1. Entre no painel → **Configurações → Conexão do WhatsApp → Configurar**.
2. Em **Provedor**, escolha **WhatsApp Oficial (Meta)**.
3. Preencha:
   - **Token de acesso permanente** → o `EAA...` do passo 2.2
   - **Phone number ID** → o do API Setup
4. **Salve.** É o salvamento que gera o *verify token* — ele aparece logo acima, junto com a URL de webhook.

### 2.4 Fechar o webhook na Meta

1. Copie do painel a **URL de webhook** e o **verify token** (cada um tem botão de copiar).
2. Na Meta: **WhatsApp → Configuration → Webhook → Edit**.
3. Cole a URL em **Callback URL** e o verify token em **Verify token** → **Verify and save**.
   - Se der erro aqui, é o `GET /webhook/whatsapp/:token` recusando: quase sempre o verify token foi colado com espaço, ou a conexão está inativa no painel.
4. Ainda em Configuration, em **Webhook fields**, clique em **Manage** e **assine o campo `messages`**. Sem essa assinatura a verificação passa mas nenhuma mensagem chega — é o erro mais comum e o mais silencioso.

### 2.5 Testar

1. No painel, **Testar conexão**. O status deve virar *Conectado* com algo como “Número ativo na Meta: <nome> · <número>”.
2. Mande uma mensagem **de um celular cadastrado** para o número da Meta.
3. Confirme: a conversa aparece no painel e o agente responde.
4. Teste também **áudio** e **imagem** — o caminho de mídia da Meta é diferente (handle + download autenticado) e é o que tem mais chance de esconder um problema.

> **Duas diferenças de comportamento da Meta**, ambas esperadas e não são bug:
> - **Janela de 24h.** Fora de 24h desde a última mensagem do cliente, a Meta só aceita template aprovado. O atendimento reativo cai dentro da janela; iniciar conversa pelo painel no dia seguinte falha, e o log explica.
> - **Sem eco do celular.** A Meta não avisa quando você responde pelo aparelho, então a pausa-por-humano (30 min) **não dispara** neste provedor. Funcionava na Z-API.

---

## PARTE 3 — Envs de segurança pendentes no Render

### 3.1 Cadeado dos números bloqueados (está 503 agora)

O e-mail e o hash saíram do código. Enquanto não forem definidos, `/blocked/unlock` responde 503.

```bash
echo sua_senha_nova | npm run hash-password --workspace server
```

No Render → Environment, defina `BLOCK_ADMIN_EMAIL` e `BLOCK_ADMIN_PASSWORD_HASH`.

> **Use senha NOVA.** A antiga esteve num repositório público — trate-a como vazada.

### 3.2 `WEBHOOK_VERIFY_TOKEN`

Só importa se você voltar a usar a rota legada `/webhook/whatsapp` (sem token na URL). Com a Meta você usa a rota por empresa, então **pode deixar em branco** — o aviso no boot é esperado.

### 3.3 `MEDIA_FETCH_ALLOWLIST` (opcional)

Restringe de quais hosts o servidor aceita baixar mídia recebida. Se for usar com a Meta, inclua `lookaside.fbsbx.com`. **Deixar vazio é mais seguro do que preencher errado** — vazio mantém as regras de bloqueio de IP privado, que são a defesa principal.

---

## PARTE 4 — Backfill das URLs de mídia

Só depois que o sistema estiver recebendo mensagens de novo.

1. Rode uma vez (Render → Shell, ou local apontando para o Neon):
   ```bash
   npm run backfill-media-tokens --workspace server
   ```
   É idempotente: URLs que já têm `?t=` são ignoradas, rodar duas vezes não estraga nada.
2. Confira no painel que áudios e imagens antigos ainda abrem.
3. Só então, no Render: `MEDIA_LEGACY_FALLBACK=false`.

Fazer o passo 3 antes do 1 quebra a mídia antiga (vira 404).

---

## PARTE 5 — Testar os recursos novos

### 5.1 Convites (entrada de cliente novo)

1. Entre como super-admin → **/admin** → **Convites de acesso**.
2. Gere um convite (o link é copiado automaticamente).
3. Abra o link numa **janela anônima** — tem que carregar a tela de criação de conta.
4. Crie uma empresa de teste e confirme que cai direto no painel, já logado.
5. Volte ao /admin e confirme que a empresa apareceu com o badge do teste.
6. Para validar o bloqueio: no /admin, ajuste o prazo do teste para vencido e recarregue o painel daquela empresa — deve aparecer a tela “Acesso pausado”, e não erro.

### 5.2 Lembretes

1. **Configurações → Lembretes pessoais** → autorize seu número com DDI e DDD (`5511999998888`).
2. Do seu celular, mande para o número do atendente: *“me lembra amanhã às 9h de pagar o fornecedor”*.
3. Deve vir uma confirmação com a data resolvida. Responda **sim**.
4. Mande **HOJE**, **TODOS** e **AJUDA** para ver as consultas.
5. Repita **por áudio** — é o caminho que depende de STT e o que mais erra.
6. Para ver o disparo sem esperar, crie um para daqui a 2 minutos.

> ⚠️ O agendador é um `setInterval` num processo 24/7. O plano do Render está como `starter` no `render.yaml`, que não hiberna — se um dia cair para free, os lembretes atrasam até alguém acordar o serviço.

---

## PARTE 6 — Decisão em aberto

**`react-router` 6 → 7** (2 vulnerabilidades moderadas). Ficou de fora por ser major com breaking changes, decisão registrada no `mayra-B1-correcao-fase1.MD`. Das duas falhas, a de hidratação SSR não se aplica (o painel é SPA sem SSR); sobra um open redirect via barra invertida em `<Link>`/`useNavigate`. Vira prioridade se a navegação passar a receber URL vinda do usuário (query string, deep link).

---

## Checklist

- [ ] Migrations 021→024 confirmadas no log do Render
- [ ] `FRONTEND_URL` apontando para o Vercel
- [ ] App criado na Meta + produto WhatsApp adicionado
- [ ] Token **permanente** gerado via usuário do sistema
- [ ] Token + phone number ID salvos no painel
- [ ] Callback URL + verify token configurados na Meta
- [ ] **Campo `messages` assinado** em Webhook fields
- [ ] Mensagem de teste recebida e respondida
- [ ] Áudio e imagem testados
- [ ] `BLOCK_ADMIN_EMAIL` + `BLOCK_ADMIN_PASSWORD_HASH` com senha nova
- [ ] `backfill-media-tokens` executado
- [ ] `MEDIA_LEGACY_FALLBACK=false` depois do backfill
- [ ] Convite testado ponta a ponta em janela anônima
- [ ] Lembrete testado por texto e por áudio

---

## Se for retomar isto com o agente depois

Cole o texto abaixo numa sessão nova:

```
Repo: C:\Users\Bruno\atendente (monorepo mayra-ai-sales), branch main, já deployado
no Render (https://mayra-api.onrender.com) e Vercel.

Contexto: a Z-API caiu por falta de pagamento e migramos para a Meta Cloud API,
que já está implementada (server/src/services/whatsapp/metacloud.service.ts) e
integrada ao painel em Configurações → Conexão do WhatsApp.

Leia mayra-C1-pos-deploy.MD e me ajude a executar o que ainda está desmarcado no
checklist. Estou travado em: <descreva onde parou, com a mensagem de erro exata
e o print/log se houver>.

Regras: não empurre para main sem eu confirmar; typecheck e build verdes antes de
qualquer commit; nenhum segredo real em código, log ou arquivo versionado.
```
