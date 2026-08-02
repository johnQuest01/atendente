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

  // Chave para cifrar segredos no banco (credenciais de WhatsApp de cada
  // empresa). Aceita base64/hex de 32 bytes OU qualquer texto (derivamos 32
  // bytes via SHA-256). Sem ela, o cadastro de conexao por empresa fica
  // indisponivel (o tenant padrao ainda funciona via .env).
  ENCRYPTION_KEY: z.string().optional(),

  // E-mail do dono da plataforma (super-admin). No seed, este usuario e
  // promovido a 'superadmin' (cria/gerencia as empresas). Opcional.
  SUPERADMIN_EMAIL: z.string().email().optional(),
  // Senha do super-admin. So e usada se o usuario SUPERADMIN_EMAIL ainda nao
  // existir (o seed cria a conta). Se o usuario ja existe, apenas promovemos.
  SUPERADMIN_PASSWORD: z.string().min(8).optional(),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-6'),
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

  // ---------- Storage de mídia compatível com S3 (Cloudflare R2 recomendado) ----------
  // Com estes campos preenchidos, áudios/imagens vão para o bucket e ganham uma
  // URL pública PERMANENTE (CDN), que a Z-API sempre consegue baixar — mesmo que
  // o backend esteja reiniciando. Sem eles, cai no modo local (disco/dev).
  // .trim() em todos: colar no painel do Render costuma trazer espaço ou quebra
  // de linha junto, e um único caractere invisível na chave faz o R2 responder
  // 401 Unauthorized — erro que não dá nenhuma pista da causa real.
  S3_BUCKET: z.string().trim().optional(),
  S3_ACCESS_KEY: z.string().trim().optional(),
  S3_SECRET_KEY: z.string().trim().optional(),
  // Endpoint S3. No R2 é https://<accountid>.r2.cloudflarestorage.com — se você
  // informar R2_ACCOUNT_ID, montamos este endpoint automaticamente.
  S3_ENDPOINT: z.string().trim().optional(),
  S3_REGION: z.string().trim().default('auto'),
  // URL pública/CDN do bucket (ex.: https://pub-xxxx.r2.dev ou domínio próprio).
  // É o que vai no file_url e é enviado à Z-API.
  S3_PUBLIC_URL: z.string().trim().url().optional(),
  // Atalho para R2: só o Account ID; o endpoint S3 é derivado dele.
  R2_ACCOUNT_ID: z.string().trim().optional(),

  SEED_ADMIN_NAME: z.string().default('Mayra'),
  SEED_ADMIN_EMAIL: z.string().email().default('mayra@loja.com'),
  SEED_ADMIN_PASSWORD: z.string().min(6).default('mudar123'),

  // Acesso restrito à área de "Números bloqueados". Sem default no código —
  // se ausentes, /blocked/unlock responde 503 (o boot do servidor segue).
  BLOCK_ADMIN_EMAIL: z.string().email().optional(),
  BLOCK_ADMIN_PASSWORD_HASH: z.string().min(20).optional(),

  // SSRF: sufixos de host permitidos no download de mídia inbound (vírgula).
  // Vazio/ausente → só as regras de IP privado valem.
  MEDIA_FETCH_ALLOWLIST: z.string().optional(),

  // /media sem ?t= válido: true = fallback legado (compat); false = 404.
  // Desligar só depois do backfill (npm run backfill-media-tokens).
  MEDIA_LEGACY_FALLBACK: booleanish(true),

  // Pausa da IA após intervenção humana (fromMe genuíno), em minutos.
  HUMAN_TAKEOVER_MINUTES: z.coerce.number().int().positive().default(30),

  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_SSL: booleanish(true),

  // Defesa em profundidade (RLS): quando true (padrão), cada requisição seta
  // app.tenant_id e o banco aplica Row-Level Security por empresa. Kill-switch:
  // defina RLS_ENFORCE=false para voltar ao isolamento só na aplicação sem
  // redeploy/rollback de migration, caso algo inesperado ocorra em produção.
  RLS_ENFORCE: booleanish(true),
}).superRefine((data, ctx) => {
  // Em produção, exigimos um segredo de JWT forte (>= 32 chars).
  if (data.NODE_ENV === 'production' && data.JWT_SECRET.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_SECRET'],
      message: 'Em produção, JWT_SECRET deve ter ao menos 32 caracteres.',
    });
  }
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

// Endpoint S3 efetivo: usa S3_ENDPOINT explícito ou, no R2, deriva do Account ID.
const s3Endpoint =
  data.S3_ENDPOINT ??
  (data.R2_ACCOUNT_ID ? `https://${data.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

// Storage remoto considerado "configurado" só quando há TUDO o que é preciso
// para subir e gerar uma URL pública estável.
const hasRemoteStorage = Boolean(
  s3Endpoint &&
    data.S3_BUCKET &&
    data.S3_ACCESS_KEY &&
    data.S3_SECRET_KEY &&
    data.S3_PUBLIC_URL,
);

export const env = {
  ...data,
  isProd: data.NODE_ENV === 'production',
  isDev: data.NODE_ENV === 'development',
  uploadDirAbsolute: path.isAbsolute(data.UPLOAD_DIR)
    ? data.UPLOAD_DIR
    : path.resolve(__dirname, '../../', data.UPLOAD_DIR),
  hasAnthropic: Boolean(data.ANTHROPIC_API_KEY),
  hasEncryption: Boolean(data.ENCRYPTION_KEY),
  hasStt: data.STT_PROVIDER === 'openai' && Boolean(data.STT_API_KEY),
  hasZapi: Boolean(data.ZAPI_INSTANCE_ID && data.ZAPI_TOKEN),
  hasEvolution: Boolean(data.EVOLUTION_API_KEY && data.EVOLUTION_INSTANCE),
  hasWhatsapp:
    data.WHATSAPP_PROVIDER === 'evolution'
      ? Boolean(data.EVOLUTION_API_KEY && data.EVOLUTION_INSTANCE)
      : Boolean(data.ZAPI_INSTANCE_ID && data.ZAPI_TOKEN),
  // Storage remoto (R2/S3)
  s3Endpoint,
  hasRemoteStorage,
  // Remove a barra final da URL pública para concatenar com segurança.
  s3PublicUrl: data.S3_PUBLIC_URL?.replace(/\/+$/, ''),
} as const;

export type Env = typeof env;
