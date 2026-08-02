import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  isAgentEnabled,
  setAgentEnabled,
  getAiPersona,
  setAiPersona,
  getAiTemperature,
  setAiTemperature,
  getAiMaxTokens,
  setAiMaxTokens,
  getReminderPersona,
  setReminderPersona,
  isMemoryScanEnabled,
  setMemoryScanEnabled,
  readSetting,
  writeSetting,
} from '../db/queries/settings';
import { DEFAULT_AI_PERSONA, DEFAULT_REMINDER_PERSONA } from '../config/persona';
import {
  BEHAVIOR_SETTINGS,
  coerceBehaviorValue,
  findBehaviorSetting,
} from '../config/behavior-settings';
import { getHealthReport } from '../services/health.service';
import { previewReply } from '../services/ai.service';
import { parseReminder } from '../services/reminders/parse.service';
import { listProducts } from '../db/queries/products';
import { listScripts } from '../db/queries/messages_scripts';
import { getTenantWhatsapp, invalidateTenantWhatsapp } from '../services/whatsapp.service';
import {
  generateVerifyToken,
  getConnectionByTenant,
  updateConnectionStatus,
  upsertConnection,
  type WhatsappSecrets,
} from '../db/queries/whatsapp_connections';
import { hasEncryptionKey } from '../utils/crypto';
import { env } from '../config/env';
import { AppError, NotFoundError } from '../utils/errors';
import { emitAgentStatus } from '../socket';

export const updateAgentSchema = z.object({
  enabled: z.boolean(),
});

export async function getAgentStatus(req: Request, res: Response): Promise<void> {
  const enabled = await isAgentEnabled(req.user!.tenant_id);
  res.json({ enabled });
}

export async function putAgentStatus(req: Request, res: Response): Promise<void> {
  const { enabled } = req.body as z.infer<typeof updateAgentSchema>;
  await setAgentEnabled(req.user!.tenant_id, enabled);
  emitAgentStatus(req.user!.tenant_id, enabled);
  res.json({ enabled });
}

export const updatePersonaSchema = z.object({
  // Vazio é permitido: limpa a personalização e volta ao padrão.
  prompt: z.string().max(12000, 'O texto está muito longo (máx. 12000 caracteres).'),
  temperature: z.coerce.number().min(0).max(1.5).optional(),
  maxTokens: z.coerce.number().int().min(50).max(1200).optional(),
});

export async function getPersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const [prompt, temperature, maxTokens] = await Promise.all([
    getAiPersona(tenantId),
    getAiTemperature(tenantId),
    getAiMaxTokens(tenantId),
  ]);
  res.json({
    prompt,
    default: DEFAULT_AI_PERSONA,
    isDefault: prompt === DEFAULT_AI_PERSONA,
    temperature,
    maxTokens,
  });
}

export async function putPersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { prompt, temperature, maxTokens } = req.body as z.infer<typeof updatePersonaSchema>;
  const effective = await setAiPersona(tenantId, prompt);
  const temp =
    temperature !== undefined ? await setAiTemperature(tenantId, temperature) : await getAiTemperature(tenantId);
  const tokens =
    maxTokens !== undefined ? await setAiMaxTokens(tenantId, maxTokens) : await getAiMaxTokens(tenantId);
  res.json({
    prompt: effective,
    default: DEFAULT_AI_PERSONA,
    isDefault: effective === DEFAULT_AI_PERSONA,
    temperature: temp,
    maxTokens: tokens,
  });
}

export const previewPersonaSchema = z.object({
  // Texto do prompt sendo editado (opcional: se ausente, usa o salvo).
  prompt: z.string().max(12000).optional(),
  message: z.string().trim().min(1, 'Digite uma mensagem para testar.').max(2000),
  temperature: z.coerce.number().min(0).max(1.5).optional(),
  maxTokens: z.coerce.number().int().min(50).max(1200).optional(),
  // Qual persona testar: a de vendas (padrão) ou a do assistente de lembretes.
  target: z.enum(['sales', 'reminder']).default('sales'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(4000),
      }),
    )
    .max(20)
    .optional(),
});

/**
 * Playground do prompt. `target='sales'` gera uma resposta de exemplo do
 * atendente (catálogo + scripts + cadeia de IA). `target='reminder'` interpreta
 * a frase como o dono a diria e devolve o texto de confirmação do lembrete, com
 * o TOM da persona sendo editada. Nada é enviado no WhatsApp nem salvo.
 */
export async function previewPersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const body = req.body as z.infer<typeof previewPersonaSchema>;

  if (body.target === 'reminder') {
    // Usa a persona sendo editada (mesmo sem salvar); string vazia = padrão.
    const parsed = await parseReminder(tenantId, body.message, undefined, {
      personaOverride: body.prompt !== undefined ? body.prompt : undefined,
    });
    res.json({
      reply: parsed?.confirmationText ?? null,
      providerLabel: null,
      detail: parsed
        ? null
        : 'Não consegui interpretar um lembrete nessa frase (ou não há IA ativa). ' +
          'Tente algo como "me lembra amanhã às 9h de pagar o fornecedor".',
    });
    return;
  }

  const systemPrompt = body.prompt !== undefined ? body.prompt : await getAiPersona(tenantId);
  const [products, scripts] = await Promise.all([
    listProducts(tenantId, true),
    listScripts(tenantId, true),
  ]);

  const result = await previewReply(
    {
      systemPrompt,
      storeName: env.STORE_NAME,
      products,
      scripts,
      client: null,
      userMessage: body.message,
      history: body.history,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
    },
    tenantId,
  );

  res.json({
    reply: result.reply,
    providerLabel: result.providerLabel,
    detail: result.reply
      ? null
      : 'A IA não respondeu. Confira se há um provedor ativo e com créditos em Configurações → Inteligência Artificial.',
  });
}

// ---------------------------------------------------------------------------
// Persona do assistente de lembretes (como a "secretária" fala com o dono)
// ---------------------------------------------------------------------------

export const updateReminderPersonaSchema = z.object({
  prompt: z.string().max(12000, 'O texto está muito longo (máx. 12000 caracteres).'),
});

export async function getReminderPersonaHandler(req: Request, res: Response): Promise<void> {
  const prompt = await getReminderPersona(req.user!.tenant_id);
  res.json({
    prompt,
    default: DEFAULT_REMINDER_PERSONA,
    isDefault: prompt === DEFAULT_REMINDER_PERSONA,
  });
}

export async function putReminderPersona(req: Request, res: Response): Promise<void> {
  const { prompt } = req.body as z.infer<typeof updateReminderPersonaSchema>;
  const effective = await setReminderPersona(req.user!.tenant_id, prompt);
  res.json({
    prompt: effective,
    default: DEFAULT_REMINDER_PERSONA,
    isDefault: effective === DEFAULT_REMINDER_PERSONA,
  });
}

// ---------------------------------------------------------------------------
// Registro de comportamento (config-driven): adicionar 1 linha em
// behavior-settings.ts expõe um novo ajuste editável, sem recodificar a UI.
// ---------------------------------------------------------------------------

export async function getBehaviorSettings(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const settings = await Promise.all(
    BEHAVIOR_SETTINGS.map(async (s) => {
      const value = await readSetting(tenantId, s.key);
      return { ...s, value: value ?? s.default };
    }),
  );
  res.json({ settings });
}

export const behaviorKeyParamSchema = z.object({ key: z.string().trim().min(1).max(64) });
export const updateBehaviorSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export async function putBehaviorSetting(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { key } = req.params as z.infer<typeof behaviorKeyParamSchema>;
  const setting = findBehaviorSetting(key);
  if (!setting) throw new NotFoundError('Configuração');

  const { value } = req.body as z.infer<typeof updateBehaviorSchema>;
  const normalized = coerceBehaviorValue(setting, value); // valida (400 se torto)
  await writeSetting(tenantId, key, normalized);
  res.json({ key, value: normalized });
}

// ---------------------------------------------------------------------------
// Varredura de conversas (opcional, OFF por padrão) — só o liga/desliga aqui.
// O acionamento é pelo WhatsApp do dono ("RECUPERAR COMPROMISSOS"), que já é
// owner-gated e propõe/confirma antes de salvar.
// ---------------------------------------------------------------------------

export async function getMemoryScan(req: Request, res: Response): Promise<void> {
  const enabled = await isMemoryScanEnabled(req.user!.tenant_id);
  res.json({ enabled });
}

export const updateMemoryScanSchema = z.object({ enabled: z.boolean() });

export async function putMemoryScan(req: Request, res: Response): Promise<void> {
  const { enabled } = req.body as z.infer<typeof updateMemoryScanSchema>;
  await setMemoryScanEnabled(req.user!.tenant_id, enabled);
  res.json({ enabled });
}

/**
 * Status REAL do sistema: testa de fato cada serviço (banco, Claude, WhatsApp,
 * STT). `?force=1` ignora o cache curto. Autenticado (vem da tela de status).
 */
export async function getSystemStatus(req: Request, res: Response): Promise<void> {
  const force = req.query.force === '1' || req.query.force === 'true';
  const report = await getHealthReport(req.user!.tenant_id, force);
  res.json(report);
}

// ---------------------------------------------------------------------------
// Conexão de WhatsApp DA EMPRESA (cada tenant traz a própria instância)
// ---------------------------------------------------------------------------

/** Mascara um segredo, mostrando apenas o final. Nunca devolvemos o valor cru. */
function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return '••••';
  return `••••${value.slice(-visible)}`;
}

/** Monta a "view" pública da conexão (sem expor tokens) + status ao vivo. */
async function buildWhatsappView(tenantId: string): Promise<Record<string, unknown>> {
  const conn = await getConnectionByTenant(tenantId);
  const wa = await getTenantWhatsapp(tenantId);
  const status = await wa.getConnectionStatus();
  if (conn) await updateConnectionStatus(tenantId, status).catch(() => undefined);

  const token = conn?.webhook_token ?? null;
  return {
    provider: conn?.provider ?? wa.provider,
    baseUrl: conn?.base_url ?? null,
    isActive: conn?.is_active ?? true,
    configured: wa.configured,
    encryptionAvailable: hasEncryptionKey(),
    // URL para colar no painel da Z-API/Evolution desta empresa.
    webhookUrl: token ? `${env.PUBLIC_BASE_URL}/webhook/whatsapp/${token}` : null,
    instanceId: conn?.secrets.instanceId ? maskTail(conn.secrets.instanceId) : null,
    instance: conn?.secrets.instance ? maskTail(conn.secrets.instance) : null,
    hasToken: Boolean(conn?.secrets.token),
    hasClientToken: Boolean(conn?.secrets.clientToken),
    hasApiKey: Boolean(conn?.secrets.apiKey),
    // Meta Cloud: o phone number ID não é segredo (aparece no painel da Meta) e
    // o verify token precisa ser LIDO pelo cliente para colar lá — os dois vão
    // inteiros. O access token, esse sim, nunca sai daqui.
    phoneNumberId: conn?.secrets.phoneNumberId ?? null,
    verifyToken: conn?.secrets.verifyToken ?? null,
    hasAccessToken: Boolean(conn?.secrets.accessToken),
    status,
  };
}

export async function getWhatsappConnection(req: Request, res: Response): Promise<void> {
  const view = await buildWhatsappView(req.user!.tenant_id);
  res.json(view);
}

export const updateWhatsappSchema = z.object({
  provider: z.enum(['zapi', 'evolution', 'metacloud']).default('zapi'),
  instanceId: z.string().trim().max(200).optional(),
  token: z.string().trim().max(400).optional(),
  clientToken: z.string().trim().max(400).optional(),
  apiKey: z.string().trim().max(400).optional(),
  instance: z.string().trim().max(200).optional(),
  // Meta Cloud API
  accessToken: z.string().trim().max(1000).optional(),
  phoneNumberId: z.string().trim().max(64).optional(),
  baseUrl: z.string().url().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Aponta o webhook do provedor para a URL desta empresa, por API.
 *
 * O passo manual (copiar a URL e colar no painel do provedor) é onde a
 * integração mais quebra: a instância fica conectada, o painel mostra tudo
 * verde, e mesmo assim nenhuma mensagem chega — sem erro em lugar nenhum.
 */
export async function configureWhatsappWebhook(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const conn = await getConnectionByTenant(tenantId);
  if (!conn) throw new AppError('Cadastre as credenciais do WhatsApp primeiro.', 400, 'NO_CONNECTION');

  const wa = await getTenantWhatsapp(tenantId);
  if (!wa.configured) {
    throw new AppError('Conexão incompleta — preencha as credenciais do provedor.', 400, 'NOT_CONFIGURED');
  }
  if (!wa.configureWebhook) {
    throw new AppError(
      'Este provedor não permite configurar o webhook por API — cole a URL no painel dele.',
      400,
      'MANUAL_WEBHOOK',
    );
  }

  const url = `${env.PUBLIC_BASE_URL}/webhook/whatsapp/${conn.webhook_token}`;
  const result = await wa.configureWebhook(url);
  res.status(result.ok ? 200 : 502).json({ ...result, webhookUrl: url });
}

/**
 * Corta o que vier depois da raiz da API no campo "URL base".
 *
 * É comum colar ali a URL inteira de um endpoint (ex.: `.../token/XXX/send-text`),
 * porque é ela que aparece na documentação do provedor. O código concatena o ID
 * e o token EM CIMA dessa base, então o endereço final vira impossível e todas
 * as chamadas respondem 404 — sem nenhuma pista de que a causa foi este campo.
 */
function normalizeBaseUrl(provider: string, raw: string | null): string | null {
  if (!raw) return null;
  const url = raw.trim().replace(/\/+$/, '');
  if (provider === 'zapi') {
    const m = url.match(/^(https?:\/\/[^/]+\/instances)\b/i);
    if (m) return m[1];
    // Sem "/instances" reconhecível, guarda só a origem (host) e deixa o
    // resto com o padrão do provedor.
    const cut = url.match(/^(https?:\/\/[^/]+)/i);
    return cut ? `${cut[1]}/instances` : null;
  }
  // Outros provedores: descarta caminho de endpoint óbvio, mantém o resto.
  return url.replace(/\/(token|message|send)[^]*$/i, '') || null;
}

export async function putWhatsappConnection(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  if (!hasEncryptionKey()) {
    throw new AppError(
      'Criptografia não configurada no servidor (defina ENCRYPTION_KEY) para salvar as credenciais com segurança.',
      503,
      'NO_ENCRYPTION_KEY',
    );
  }

  const input = req.body as z.infer<typeof updateWhatsappSchema>;
  const existing = await getConnectionByTenant(tenantId);
  const prev = existing?.secrets ?? {};
  // Campo vazio = "não alterar" (o front nunca recebe o segredo em texto).
  const secrets: WhatsappSecrets = {
    instanceId: input.instanceId || prev.instanceId,
    token: input.token || prev.token,
    clientToken: input.clientToken || prev.clientToken,
    apiKey: input.apiKey || prev.apiKey,
    instance: input.instance || prev.instance,
    accessToken: input.accessToken || prev.accessToken,
    phoneNumberId: input.phoneNumberId || prev.phoneNumberId,
    // Geramos o verify token na primeira vez que a empresa escolhe Meta Cloud:
    // é ele que a cliente cola no painel da Meta, e precisa ser estável depois.
    verifyToken:
      prev.verifyToken ?? (input.provider === 'metacloud' ? generateVerifyToken() : undefined),
  };

  await upsertConnection(tenantId, {
    provider: input.provider,
    secrets,
    baseUrl: normalizeBaseUrl(input.provider, input.baseUrl ?? existing?.base_url ?? null),
    isActive: input.isActive ?? existing?.is_active ?? true,
    webhookToken: existing?.webhook_token,
  });
  invalidateTenantWhatsapp(tenantId);

  const view = await buildWhatsappView(tenantId);
  res.json(view);
}
