# Deploy da Mayra AI Sales

Arquitetura de produção:

```
Frontend (painel)  →  Vercel
Backend (API+IA)   →  Render (plano Starter)
Áudios/Imagens     →  Disco persistente do Render (/var/data/uploads)
Banco de dados     →  Neon (já configurado)
```

> Por que o backend não vai no Vercel: ele usa WebSocket (Socket.io), ffmpeg
> e disco para arquivos, além de precisar ficar sempre ativo para o webhook do
> WhatsApp — coisas que o serverless do Vercel não suporta bem.

---

## 0. Pré-requisito: subir o código para o GitHub

O Render e o Vercel fazem deploy a partir de um repositório Git.

```bash
git init
git add .
git commit -m "Mayra AI Sales"
git branch -M main
# crie um repositório vazio no GitHub e cole a URL abaixo:
git remote add origin https://github.com/SEU_USUARIO/mayra-ai-sales.git
git push -u origin main
```

O `.gitignore` já protege o `.env` e a pasta de uploads — suas chaves não vão pro GitHub.

---

## 1. Backend no Render

1. Acesse <https://dashboard.render.com> → **New** → **Blueprint**.
2. Conecte o repositório do GitHub. O Render detecta o arquivo `render.yaml` e
   cria o serviço **mayra-api** (plano **Starter ≈ US$7/mês** — necessário para
   o disco persistente e para o serviço não dormir).
3. Antes de criar, preencha as variáveis marcadas como "secret" (sync:false):

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | sua connection string do Neon |
   | `ANTHROPIC_API_KEY` | sua chave da Anthropic |
   | `ZAPI_INSTANCE_ID` | ID da instância Z-API |
   | `ZAPI_TOKEN` | token da instância Z-API |
   | `ZAPI_CLIENT_TOKEN` | client-token (token de segurança) Z-API |
   | `STT_API_KEY` | sua chave da Groq |
   | `WEBHOOK_VERIFY_TOKEN` | (opcional) um texto secreto qualquer |
   | `FRONTEND_URL` | deixe em branco por enquanto (preenche no passo 3) |

   As demais (`PUBLIC_BASE_URL`, `JWT_SECRET`, modelo de IA, STT, etc.) já são
   preenchidas automaticamente. O `PUBLIC_BASE_URL` se auto-resolve pela URL do
   próprio Render.

4. Clique em **Apply**. O build roda migrações + seed automaticamente.
5. Ao terminar, anote a URL pública, algo como `https://mayra-api.onrender.com`.
   Teste: abra `https://mayra-api.onrender.com/health` → deve responder `{"status":"ok",...}`.

---

## 2. Frontend no Vercel

1. Acesse <https://vercel.com> → **Add New** → **Project** → importe o mesmo repo.
2. O `vercel.json` já define build (`npm run build:client`) e saída (`client/dist`).
   Deixe o **Root Directory** como a raiz do repositório.
3. Em **Environment Variables**, adicione:

   | Variável | Valor |
   |---|---|
   | `VITE_API_URL` | a URL do Render, ex.: `https://mayra-api.onrender.com` |

4. **Deploy**. Ao final, você terá uma URL como `https://mayra-ai-sales.vercel.app`.

---

## 3. Ligar frontend ↔ backend (CORS)

1. Volte no Render → serviço **mayra-api** → **Environment** → defina:
   - `FRONTEND_URL` = a URL do Vercel (ex.: `https://mayra-ai-sales.vercel.app`)
2. Salve (o serviço reinicia sozinho).

---

## 4. Apontar o webhook do WhatsApp (Z-API)

No painel do Z-API, configure o webhook "Ao receber" (e status) para:

```
https://mayra-api.onrender.com/webhook/whatsapp
```

(Se você definiu `WEBHOOK_VERIFY_TOKEN`, use `…/webhook/whatsapp?token=SEU_TOKEN`.)

Agora a URL é **fixa** — não muda mais como acontecia com o túnel cloudflared.

---

## 5. Testar em produção

1. Faça login no painel do Vercel com `mayra@loja.com` / a senha de `SEED_ADMIN_PASSWORD`
   (padrão `mudar123` — **troque** definindo `SEED_ADMIN_PASSWORD` no Render antes do 1º deploy).
2. Envie uma mensagem/áudio real pelo WhatsApp e confira a resposta + o painel em tempo real.

---

## Atualizações futuras

Cada `git push` na branch `main` dispara um novo deploy automático no Render e no Vercel.

## Observações

- **Plano free do Render**: existe, mas não tem disco persistente (os áudios
  somem a cada deploy/restart) e o serviço dorme após 15 min (atrasa o webhook).
  Por isso recomendamos o Starter. Se quiser usar storage externo (Cloudflare R2)
  em vez do disco, dá para implementar no `server/src/services/storage.service.ts`.
- **Cuidado com segredos**: nunca commite o `.env`. Configure tudo pelas telas de
  Environment do Render e do Vercel.
