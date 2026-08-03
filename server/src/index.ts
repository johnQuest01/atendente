import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { corsOrigin } from './config/cors';
import { logger } from './config/logger';
import { checkDbConnection, closePool, pool } from './db';
import { initSocket } from './socket';
import apiRoutes from './routes';
import webhookRoutes from './routes/webhook.routes';
import mediaRoutes from './routes/media.routes';
import { logStorageMode } from './services/storage.service';
import { isAiConfigured } from './services/ai.service';
import { startReminderScheduler, stopReminderScheduler } from './services/reminders/scheduler.service';
import { apiLimiter, webhookLimiter } from './middleware/rateLimit.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

const app = express();

// Atrás do proxy do Render: confia no 1º proxy para enxergar o IP real
// (necessário para o rate limit funcionar por IP, e não por proxy).
app.set('trust proxy', 1);

// Cabeçalhos de segurança (clickjacking, MIME sniffing, HSTS, CSP...).
// crossOriginResourcePolicy = cross-origin para o painel/Z-API conseguirem
// carregar a mídia servida em /media e /uploads de outra origem.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos enviados (áudios/imagens) em dev local.
app.use('/uploads', express.static(env.uploadDirAbsolute));

// Mídia servida a partir do banco (estável, sobrevive a deploys). Sem auth:
// a Z-API precisa baixar o áudio para enviar ao cliente no WhatsApp.
app.use('/media', mediaRoutes);

// Healthcheck LEVE (probe do Render): só o banco, resposta rápida. O status
// REAL e detalhado das integrações fica em GET /api/settings/status (autenticado),
// para não martelar/atrasar as APIs externas no probe automático da plataforma.
// Momento em que ESTE processo subiu — junto com o commit, diz de fora se um
// deploy já entrou no ar, sem precisar abrir o painel do Render.
const BOOTED_AT = new Date().toISOString();

app.get('/health', async (_req, res) => {
  const db = await checkDbConnection();
  // Papel de conexão do runtime: 'app_runtime' quando o RLS está ativo,
  // 'neondb_owner' quando ainda no dono. Best-effort — não derruba o probe.
  let dbRole: string | null = null;
  if (db) {
    try {
      const r = await pool.query<{ u: string }>('SELECT current_user AS u');
      dbRole = r.rows[0]?.u ?? null;
    } catch {
      /* ignora */
    }
  }
  res.status(db ? 200 : 503).json({
    status: db ? 'ok' : 'degraded',
    db,
    dbRole,
    // O Render injeta o commit publicado; em dev fica 'dev'.
    commit: (process.env.RENDER_GIT_COMMIT ?? 'dev').slice(0, 7),
    bootedAt: BOOTED_AT,
    timestamp: new Date().toISOString(),
  });
});

// Webhook do WhatsApp (sem auth — protegido por token + rate limit).
app.use('/webhook', webhookLimiter, webhookRoutes);

// API autenticada (com rate limit geral).
app.use('/api', apiLimiter, apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
initSocket(server);

async function start(): Promise<void> {
  const dbOk = await checkDbConnection();
  if (!dbOk) {
    logger.warn('Não foi possível conectar ao banco no startup. O servidor subirá mesmo assim.');
  }

  server.listen(env.PORT, () => {
    logger.info(`Servidor rodando em http://localhost:${env.PORT} (${env.NODE_ENV})`);
    logStorageMode();
    void isAiConfigured().then((ok) => {
      if (!ok)
        logger.warn(
          'Nenhum provedor de IA configurado — respostas automáticas desativadas. Cadastre uma IA em /admin (ou defina ANTHROPIC_API_KEY).',
        );
    });
    if (!env.hasWhatsapp)
      logger.warn(`Provedor de WhatsApp (${env.WHATSAPP_PROVIDER}) não configurado — envios serão simulados.`);
    // Lembretes do dono: processo 24/7, então o intervalo basta. Atenção ao
    // plano do Render — se o serviço hibernar, o agendador para junto.
    startReminderScheduler();
    warnInsecureProductionConfig();
  });
}

/** Avisa (sem derrubar) sobre configurações inseguras em produção. */
function warnInsecureProductionConfig(): void {
  if (!env.isProd) return;
  if (env.SEED_ADMIN_PASSWORD === 'mudar123') {
    logger.warn('SEGURANÇA: SEED_ADMIN_PASSWORD está no padrão "mudar123". Defina uma senha forte no Render.');
  }
  if (!env.BLOCK_ADMIN_EMAIL || !env.BLOCK_ADMIN_PASSWORD_HASH) {
    logger.warn(
      'SEGURANÇA: BLOCK_ADMIN_EMAIL / BLOCK_ADMIN_PASSWORD_HASH não configurados — o cadeado (área "Números bloqueados") retornará 503. ' +
        'Defina os dois no Render: BLOCK_ADMIN_EMAIL=seu@email e BLOCK_ADMIN_PASSWORD_HASH=<hash> ' +
        '(gere o hash com: echo SUA_SENHA | npm run hash-password --workspace server).',
    );
  }
  if (!env.WEBHOOK_VERIFY_TOKEN) {
    logger.warn(
      'SEGURANÇA: WEBHOOK_VERIFY_TOKEN ausente. Em produção a rota legada /webhook/whatsapp será recusada — use /webhook/whatsapp/:webhookToken.',
    );
  }
  if (env.MEDIA_LEGACY_FALLBACK) {
    logger.warn(
      'SEGURANÇA: MEDIA_LEGACY_FALLBACK=true. Após npm run backfill-media-tokens, defina MEDIA_LEGACY_FALLBACK=false.',
    );
  }
}

function shutdown(signal: string): void {
  logger.info(`Recebido ${signal}, encerrando...`);
  stopReminderScheduler();
  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void start();

export { app, server };
