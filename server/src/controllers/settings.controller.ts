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
import { getWhatsappByConnection, invalidateTenantWhatsapp } from '../services/whatsapp.service';
import {
  createConnection,
  deleteConnection,
  generateVerifyToken,
  getConnectionById,
  getConnectionByTenant,
  listConnections,
  updateConnection,
  updateConnectionPhoneNumber,
  updateConnectionStatusById,
  type WhatsappConnection,
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
      model: null,
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
    model: result.model,
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

/** Monta a "view" pública de UMA conexão (sem expor tokens) + status ao vivo. */
async function buildConnectionView(
  tenantId: string,
  conn: WhatsappConnection,
): Promise<Record<string, unknown>> {
  const wa = await getWhatsappByConnection(tenantId, conn.id);
  const status = await wa.getConnectionStatus();
  await updateConnectionStatusById(conn.id, status).catch(() => undefined);

  // Detecta o número real da instância (ex.: Z-API GET /device) e persiste.
  let phoneNumber = conn.phone_number;
  const detected = (status.phone ?? '').replace(/\D/g, '');
  if (detected.length >= 10 && detected !== (phoneNumber ?? '')) {
    await updateConnectionPhoneNumber(conn.id, detected).catch(() => undefined);
    phoneNumber = detected;
  }

  return {
    id: conn.id,
    label: conn.label,
    phoneNumber,
    provider: conn.provider,
    baseUrl: conn.base_url,
    isActive: conn.is_active,
    configured: wa.configured,
    encryptionAvailable: hasEncryptionKey(),
    webhookUrl: `${env.PUBLIC_BASE_URL}/webhook/whatsapp/${conn.webhook_token}`,
    instanceId: conn.secrets.instanceId ? maskTail(conn.secrets.instanceId) : null,
    instance: conn.secrets.instance ? maskTail(conn.secrets.instance) : null,
    hasToken: Boolean(conn.secrets.token),
    hasClientToken: Boolean(conn.secrets.clientToken),
    hasApiKey: Boolean(conn.secrets.apiKey),
    phoneNumberId: conn.secrets.phoneNumberId ?? null,
    verifyToken: conn.secrets.verifyToken ?? null,
    hasAccessToken: Boolean(conn.secrets.accessToken),
    // IA desta instância (null = herda o padrão da empresa)
    aiPersona: conn.ai_persona,
    aiTemperature: conn.ai_temperature,
    aiMaxTokens: conn.ai_max_tokens,
    agentEnabled: conn.agent_enabled,
    status,
  };
}

export async function listWhatsappConnections(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const conns = await listConnections(tenantId);
  const connections = await Promise.all(conns.map((c) => buildConnectionView(tenantId, c)));
  res.json({
    encryptionAvailable: hasEncryptionKey(),
    connections,
  });
}

/** @deprecated Prefer listWhatsappConnections — mantém 1ª conexão para clientes antigos. */
export async function getWhatsappConnection(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const conn = await getConnectionByTenant(tenantId);
  if (!conn) {
    res.json({
      encryptionAvailable: hasEncryptionKey(),
      configured: false,
      provider: 'zapi',
      isActive: true,
      webhookUrl: null,
      status: { ok: false, detail: 'Nenhuma instância cadastrada.' },
      connections: [],
    });
    return;
  }
  const view = await buildConnectionView(tenantId, conn);
  const all = await listConnections(tenantId);
  res.json({
    ...view,
    connections: await Promise.all(all.map((c) => buildConnectionView(tenantId, c))),
  });
}

export const whatsappConnectionIdSchema = z.object({
  id: z.string().uuid(),
});

export const updateWhatsappSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  phoneNumber: z.string().trim().max(30).optional().nullable(),
  provider: z.enum(['zapi', 'evolution', 'metacloud']).default('zapi'),
  instanceId: z.string().trim().max(200).optional(),
  token: z.string().trim().max(400).optional(),
  clientToken: z.string().trim().max(400).optional(),
  apiKey: z.string().trim().max(400).optional(),
  instance: z.string().trim().max(200).optional(),
  accessToken: z.string().trim().max(1000).optional(),
  phoneNumberId: z.string().trim().max(64).optional(),
  baseUrl: z.string().url().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
  // IA por número — null/omitido herda o padrão da empresa
  aiPersona: z.string().max(20_000).optional().nullable(),
  aiTemperature: z.number().min(0).max(1.5).optional().nullable(),
  aiMaxTokens: z.number().int().min(50).max(1200).optional().nullable(),
  agentEnabled: z.boolean().optional().nullable(),
});

function normalizeBaseUrl(provider: string, raw: string | null): string | null {
  if (!raw) return null;
  const url = raw.trim().replace(/\/+$/, '');
  if (!url) return null;
  if (provider === 'zapi') {
    const m = url.match(/^(https?:\/\/[^/]+\/instances)\b/i);
    if (m) return m[1];
    const cut = url.match(/^(https?:\/\/[^/]+)/i);
    return cut ? `${cut[1]}/instances` : null;
  }
  return url.replace(/\/(token|message|send)[^]*$/i, '') || null;
}

function mergeSecrets(
  input: z.infer<typeof updateWhatsappSchema>,
  prev: WhatsappSecrets,
): WhatsappSecrets {
  return {
    instanceId: input.instanceId || prev.instanceId,
    token: input.token || prev.token,
    clientToken: input.clientToken || prev.clientToken,
    apiKey: input.apiKey || prev.apiKey,
    instance: input.instance || prev.instance,
    accessToken: input.accessToken || prev.accessToken,
    phoneNumberId: input.phoneNumberId || prev.phoneNumberId,
    verifyToken:
      prev.verifyToken ?? (input.provider === 'metacloud' ? generateVerifyToken() : undefined),
  };
}

export async function createWhatsappConnection(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  if (!hasEncryptionKey()) {
    throw new AppError(
      'Criptografia não configurada no servidor (defina ENCRYPTION_KEY) para salvar as credenciais com segurança.',
      503,
      'NO_ENCRYPTION_KEY',
    );
  }
  const input = req.body as z.infer<typeof updateWhatsappSchema>;
  const secrets = mergeSecrets(input, {});
  const conn = await createConnection(tenantId, {
    provider: input.provider,
    secrets,
    label: input.label ?? `WhatsApp ${(await listConnections(tenantId)).length + 1}`,
    phoneNumber: input.phoneNumber,
    baseUrl: normalizeBaseUrl(input.provider, input.baseUrl || null),
    isActive: input.isActive ?? true,
    aiPersona: input.aiPersona,
    aiTemperature: input.aiTemperature,
    aiMaxTokens: input.aiMaxTokens,
    agentEnabled: input.agentEnabled,
  });
  invalidateTenantWhatsapp(tenantId, conn.id);
  res.status(201).json(await buildConnectionView(tenantId, conn));
}

export async function putWhatsappConnectionById(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof whatsappConnectionIdSchema>;
  if (!hasEncryptionKey()) {
    throw new AppError(
      'Criptografia não configurada no servidor (defina ENCRYPTION_KEY) para salvar as credenciais com segurança.',
      503,
      'NO_ENCRYPTION_KEY',
    );
  }
  const existing = await getConnectionById(tenantId, id);
  if (!existing) throw new NotFoundError('Conexão WhatsApp');

  const input = req.body as z.infer<typeof updateWhatsappSchema>;
  const secrets = mergeSecrets(input, existing.secrets);
  const updated = await updateConnection(tenantId, id, {
    provider: input.provider,
    secrets,
    label: input.label ?? existing.label,
    phoneNumber: input.phoneNumber !== undefined ? input.phoneNumber : existing.phone_number,
    baseUrl: normalizeBaseUrl(
      input.provider,
      input.baseUrl !== undefined ? input.baseUrl || null : existing.base_url,
    ),
    isActive: input.isActive ?? existing.is_active,
    aiPersona: input.aiPersona !== undefined ? input.aiPersona : existing.ai_persona,
    aiTemperature: input.aiTemperature !== undefined ? input.aiTemperature : existing.ai_temperature,
    aiMaxTokens: input.aiMaxTokens !== undefined ? input.aiMaxTokens : existing.ai_max_tokens,
    agentEnabled: input.agentEnabled !== undefined ? input.agentEnabled : existing.agent_enabled,
  });
  invalidateTenantWhatsapp(tenantId, id);
  res.json(await buildConnectionView(tenantId, updated as WhatsappConnection));
}

/** Compat: PUT /whatsapp sem id atualiza a primeira ou cria. */
export async function putWhatsappConnection(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const existing = await getConnectionByTenant(tenantId);
  if (existing) {
    req.params = { ...req.params, id: existing.id };
    await putWhatsappConnectionById(req, res);
    return;
  }
  await createWhatsappConnection(req, res);
}

export async function deleteWhatsappConnection(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof whatsappConnectionIdSchema>;
  const ok = await deleteConnection(tenantId, id);
  if (!ok) throw new NotFoundError('Conexão WhatsApp');
  invalidateTenantWhatsapp(tenantId, id);
  res.status(204).send();
}

export async function configureWhatsappWebhook(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const id = (req.params as { id?: string }).id;
  const conn = id
    ? await getConnectionById(tenantId, id)
    : await getConnectionByTenant(tenantId);
  if (!conn) throw new AppError('Cadastre as credenciais do WhatsApp primeiro.', 400, 'NO_CONNECTION');

  const wa = await getWhatsappByConnection(tenantId, conn.id);
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
