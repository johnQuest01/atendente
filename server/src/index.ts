import http from 'node:http';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { corsOrigin } from './config/cors';
import { logger } from './config/logger';
import { checkDbConnection, closePool } from './db';
import { initSocket } from './socket';
import apiRoutes from './routes';
import webhookRoutes from './routes/webhook.routes';
import mediaRoutes from './routes/media.routes';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

const app = express();

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

// Healthcheck.
app.get('/health', async (_req, res) => {
  const db = await checkDbConnection();
  res.status(db ? 200 : 503).json({
    status: db ? 'ok' : 'degraded',
    db,
    anthropic: env.hasAnthropic,
    transcription: env.hasStt,
    zapi: env.hasWhatsapp,
    whatsappProvider: env.WHATSAPP_PROVIDER,
    timestamp: new Date().toISOString(),
  });
});

// Webhook do WhatsApp (sem auth — protegido por token opcional).
app.use('/webhook', webhookRoutes);

// API autenticada.
app.use('/api', apiRoutes);

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
    logger.info(`Uploads servidos de: ${path.relative(process.cwd(), env.uploadDirAbsolute)}`);
    if (!env.hasAnthropic) logger.warn('ANTHROPIC_API_KEY ausente — respostas via Claude desativadas.');
    if (!env.hasWhatsapp)
      logger.warn(`Provedor de WhatsApp (${env.WHATSAPP_PROVIDER}) não configurado — envios serão simulados.`);
  });
}

function shutdown(signal: string): void {
  logger.info(`Recebido ${signal}, encerrando...`);
  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void start();

export { app, server };
