import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Carrega o .env da raiz do monorepo (um nível acima de /server) e,
// como fallback, um .env local dentro de /server.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const booleanish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  // Aceita uma URL ou várias separadas por vírgula (ex.: produção + localhost).
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET deve ter ao menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-20250514'),
  STORE_NAME: z.string().optional(),

  // Provedor de WhatsApp ativo.
  WHATSAPP_PROVIDER: z.enum(['zapi', 'evolution']).default('zapi'),

  // Z-API
  ZAPI_INSTANCE_ID: z.string().optional(),
  ZAPI_TOKEN: z.string().optional(),
  ZAPI_BASE_URL: z.string().url().default('https://api.z-api.io/instances'),
  ZAPI_CLIENT_TOKEN: z.string().optional(),

  // Evolution API (self-hosted)
  EVOLUTION_BASE_URL: z.string().url().default('http://localhost:8080'),
  EVOLUTION_API_KEY: z.string().optional(),
  EVOLUTION_INSTANCE: z.string().optional(),

  WEBHOOK_VERIFY_TOKEN: z.string().optional(),

  // Transcrição de áudio (speech-to-text) — usada para "entender" os áudios
  // que o cliente envia. Compatível com a API da OpenAI (também funciona com
  // Groq, que tem cota gratuita). "none" desativa a transcrição.
  STT_PROVIDER: z.enum(['none', 'openai']).default('none'),
  STT_API_KEY: z.string().optional(),
  STT_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  STT_MODEL: z.string().default('whisper-1'),
  STT_LANGUAGE: z.string().default('pt'),

  UPLOAD_DIR: z.string().default('./uploads'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3001'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),

  SEED_ADMIN_NAME: z.string().default('Mayra'),
  SEED_ADMIN_EMAIL: z.string().email().default('mayra@loja.com'),
  SEED_ADMIN_PASSWORD: z.string().min(6).default('mudar123'),

  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_SSL: booleanish(true),
});

// Remove variáveis com string vazia para que campos opcionais (ex:
// ANTHROPIC_API_KEY=) sejam tratados como "não informados" em vez de
// falharem em validações como .min(1).
const cleanedEnv: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && value.trim() !== '') cleanedEnv[key] = value;
}

// Em produção no Render, a plataforma injeta RENDER_EXTERNAL_URL com a URL
// pública do serviço. Usamos como PUBLIC_BASE_URL quando este não for definido,
// evitando configuração manual e URLs de mídia desatualizadas.
if (!cleanedEnv.PUBLIC_BASE_URL && cleanedEnv.RENDER_EXTERNAL_URL) {
  cleanedEnv.PUBLIC_BASE_URL = cleanedEnv.RENDER_EXTERNAL_URL;
}

const parsed = envSchema.safeParse(cleanedEnv);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\n[config] Variáveis de ambiente inválidas:\n${issues}\n`);
  process.exit(1);
}

const data = parsed.data;

export const env = {
  ...data,
  isProd: data.NODE_ENV === 'production',
  isDev: data.NODE_ENV === 'development',
  uploadDirAbsolute: path.isAbsolute(data.UPLOAD_DIR)
    ? data.UPLOAD_DIR
    : path.resolve(__dirname, '../../', data.UPLOAD_DIR),
  hasAnthropic: Boolean(data.ANTHROPIC_API_KEY),
  hasStt: data.STT_PROVIDER === 'openai' && Boolean(data.STT_API_KEY),
  hasZapi: Boolean(data.ZAPI_INSTANCE_ID && data.ZAPI_TOKEN),
  hasEvolution: Boolean(data.EVOLUTION_API_KEY && data.EVOLUTION_INSTANCE),
  hasWhatsapp:
    data.WHATSAPP_PROVIDER === 'evolution'
      ? Boolean(data.EVOLUTION_API_KEY && data.EVOLUTION_INSTANCE)
      : Boolean(data.ZAPI_INSTANCE_ID && data.ZAPI_TOKEN),
} as const;

export type Env = typeof env;
