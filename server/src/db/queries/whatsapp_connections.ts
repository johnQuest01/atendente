import crypto from 'node:crypto';
import { query, queryOne } from '../index';
import { encryptSecret, decryptSecret } from '../../utils/crypto';

/**
 * Conexões de WhatsApp POR EMPRESA. Um tenant pode ter N instâncias
 * independentes (Z-API / Evolution / Meta Cloud). Cada uma tem webhook próprio
 * e pode ter persona/temperatura/agente próprios (NULL = herda settings do tenant).
 */

export type WhatsappProviderName = 'zapi' | 'evolution' | 'metacloud';
export type ProviderMode = 'web' | 'phoneless';
export type InstanceOrigin = 'on_demand' | 'pool' | 'manual';
export type ConnectionLifecycleStatus =
  | 'PROVISIONING'
  | 'AGUARDANDO_LEITURA'
  | 'CONECTANDO'
  | 'CONECTADO'
  | 'ERRO'
  | 'EXPIRADO'
  | 'DESCONECTADO';

export interface WhatsappSecrets {
  instanceId?: string;
  token?: string;
  clientToken?: string;
  apiKey?: string;
  instance?: string;
  accessToken?: string;
  phoneNumberId?: string;
  verifyToken?: string;
}

export interface WhatsappConnection {
  id: string;
  tenant_id: string;
  provider: WhatsappProviderName;
  label: string;
  phone_number: string | null;
  base_url: string | null;
  webhook_token: string;
  is_active: boolean;
  ai_persona: string | null;
  ai_temperature: number | null;
  ai_max_tokens: number | null;
  agent_enabled: boolean | null;
  reminder_assistant_persona: string | null;
  memory_scan_enabled: boolean | null;
  /** NULL/true = secretária ligada; false = desliga agenda neste número. */
  owner_secretary_enabled: boolean | null;
  /** NULL/false = off; true = chat livre (modo Agente). */
  owner_free_chat_enabled: boolean | null;
  /** NULL/false = off; true = busca web no Agente. */
  owner_web_search_enabled: boolean | null;
  provider_mode: ProviderMode;
  instance_origin: InstanceOrigin;
  connection_status: ConnectionLifecycleStatus;
  webhook_configured: boolean;
  zapi_subscribed: boolean;
  pool_instance_id: string | null;
  onboarding_started_at: string | null;
  onboarding_expires_at: string | null;
  last_status: string | null;
  last_status_detail: string | null;
  last_status_at: string | null;
  secrets: WhatsappSecrets;
  created_at?: string;
  updated_at?: string;
}

interface ConnectionRow {
  id: string;
  tenant_id: string;
  provider: WhatsappProviderName;
  label: string | null;
  phone_number: string | null;
  secrets_encrypted: string | null;
  base_url: string | null;
  webhook_token: string;
  is_active: boolean;
  ai_persona: string | null;
  ai_temperature: string | number | null;
  ai_max_tokens: number | null;
  agent_enabled: boolean | null;
  reminder_assistant_persona: string | null;
  memory_scan_enabled: boolean | null;
  owner_secretary_enabled?: boolean | null;
  owner_free_chat_enabled?: boolean | null;
  owner_web_search_enabled?: boolean | null;
  provider_mode?: ProviderMode | null;
  instance_origin?: InstanceOrigin | null;
  connection_status?: ConnectionLifecycleStatus | null;
  webhook_configured?: boolean | null;
  zapi_subscribed?: boolean | null;
  pool_instance_id?: string | null;
  onboarding_started_at?: string | null;
  onboarding_expires_at?: string | null;
  last_status: string | null;
  last_status_detail: string | null;
  last_status_at: string | null;
  created_at?: string;
  updated_at?: string;
}

const COLS = `id, tenant_id, provider, label, phone_number, secrets_encrypted, base_url,
  webhook_token, is_active, ai_persona, ai_temperature, ai_max_tokens, agent_enabled,
  reminder_assistant_persona, memory_scan_enabled,
  owner_secretary_enabled, owner_free_chat_enabled, owner_web_search_enabled,
  provider_mode, instance_origin, connection_status, webhook_configured, zapi_subscribed,
  pool_instance_id, onboarding_started_at, onboarding_expires_at,
  last_status, last_status_detail, last_status_at, created_at, updated_at`;

function decodeSecrets(enc: string | null): WhatsappSecrets {
  if (!enc) return {};
  try {
    return JSON.parse(decryptSecret(enc)) as WhatsappSecrets;
  } catch {
    return {};
  }
}

function mapRow(row: ConnectionRow): WhatsappConnection {
  const temp =
    row.ai_temperature === null || row.ai_temperature === undefined
      ? null
      : Number(row.ai_temperature);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    provider: row.provider,
    label: (row.label && row.label.trim()) || 'WhatsApp',
    phone_number: row.phone_number,
    base_url: row.base_url,
    webhook_token: row.webhook_token,
    is_active: row.is_active,
    ai_persona: row.ai_persona,
    ai_temperature: Number.isFinite(temp as number) ? (temp as number) : null,
    ai_max_tokens: row.ai_max_tokens,
    agent_enabled: row.agent_enabled,
    reminder_assistant_persona: row.reminder_assistant_persona ?? null,
    memory_scan_enabled: row.memory_scan_enabled ?? null,
    owner_secretary_enabled: row.owner_secretary_enabled ?? null,
    owner_free_chat_enabled: row.owner_free_chat_enabled ?? null,
    owner_web_search_enabled: row.owner_web_search_enabled ?? null,
    provider_mode: row.provider_mode ?? 'web',
    instance_origin: row.instance_origin ?? 'manual',
    connection_status: row.connection_status ?? 'DESCONECTADO',
    webhook_configured: Boolean(row.webhook_configured),
    zapi_subscribed: Boolean(row.zapi_subscribed),
    pool_instance_id: row.pool_instance_id ?? null,
    onboarding_started_at: row.onboarding_started_at ?? null,
    onboarding_expires_at: row.onboarding_expires_at ?? null,
    last_status: row.last_status,
    last_status_detail: row.last_status_detail,
    last_status_at: row.last_status_at,
    secrets: decodeSecrets(row.secrets_encrypted),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function generateVerifyToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Lista todas as conexões da empresa (mais antigas primeiro). */
export async function listConnections(tenantId: string): Promise<WhatsappConnection[]> {
  const { rows } = await query<ConnectionRow>(
    `SELECT ${COLS} FROM whatsapp_connections
      WHERE tenant_id = $1
      ORDER BY created_at ASC, id ASC`,
    [tenantId],
  );
  return rows.map(mapRow);
}

/** Primeira conexão ativa (ou qualquer) — compatibilidade com código legado. */
export async function getConnectionByTenant(tenantId: string): Promise<WhatsappConnection | null> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${COLS} FROM whatsapp_connections
      WHERE tenant_id = $1
      ORDER BY is_active DESC, created_at ASC, id ASC
      LIMIT 1`,
    [tenantId],
  );
  return row ? mapRow(row) : null;
}

export async function getConnectionById(
  tenantId: string,
  id: string,
): Promise<WhatsappConnection | null> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${COLS} FROM whatsapp_connections WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return row ? mapRow(row) : null;
}

export async function getConnectionByWebhookToken(token: string): Promise<WhatsappConnection | null> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${COLS} FROM whatsapp_connections WHERE webhook_token = $1`,
    [token],
  );
  return row ? mapRow(row) : null;
}

export interface ConnectionWriteInput {
  provider: WhatsappProviderName;
  secrets: WhatsappSecrets;
  label?: string | null;
  phoneNumber?: string | null;
  baseUrl?: string | null;
  isActive?: boolean;
  webhookToken?: string;
  aiPersona?: string | null;
  aiTemperature?: number | null;
  aiMaxTokens?: number | null;
  agentEnabled?: boolean | null;
}

export async function createConnection(
  tenantId: string,
  input: ConnectionWriteInput,
): Promise<WhatsappConnection> {
  const encrypted = encryptSecret(JSON.stringify(input.secrets ?? {}));
  const token = input.webhookToken ?? generateWebhookToken();
  const label = (input.label?.trim() || 'WhatsApp').slice(0, 120);
  const row = await queryOne<ConnectionRow>(
    `INSERT INTO whatsapp_connections
       (tenant_id, provider, label, phone_number, secrets_encrypted, base_url, is_active,
        webhook_token, ai_persona, ai_temperature, ai_max_tokens, agent_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${COLS}`,
    [
      tenantId,
      input.provider,
      label,
      input.phoneNumber?.trim() || null,
      encrypted,
      input.baseUrl ?? null,
      input.isActive ?? true,
      token,
      input.aiPersona?.trim() || null,
      input.aiTemperature ?? null,
      input.aiMaxTokens ?? null,
      input.agentEnabled ?? null,
    ],
  );
  return mapRow(row as ConnectionRow);
}

export async function updateConnection(
  tenantId: string,
  id: string,
  input: ConnectionWriteInput,
): Promise<WhatsappConnection | null> {
  const encrypted = encryptSecret(JSON.stringify(input.secrets ?? {}));
  const label = (input.label?.trim() || 'WhatsApp').slice(0, 120);
  const row = await queryOne<ConnectionRow>(
    `UPDATE whatsapp_connections SET
       provider = $3,
       label = $4,
       phone_number = $5,
       secrets_encrypted = $6,
       base_url = $7,
       is_active = $8,
       ai_persona = $9,
       ai_temperature = $10,
       ai_max_tokens = $11,
       agent_enabled = $12,
       updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLS}`,
    [
      tenantId,
      id,
      input.provider,
      label,
      input.phoneNumber?.trim() || null,
      encrypted,
      input.baseUrl ?? null,
      input.isActive ?? true,
      input.aiPersona?.trim() || null,
      input.aiTemperature ?? null,
      input.aiMaxTokens ?? null,
      input.agentEnabled ?? null,
    ],
  );
  return row ? mapRow(row) : null;
}

/**
 * @deprecated Use createConnection / updateConnection. Mantido para quem ainda
 * chama o upsert antigo: atualiza a primeira conexão ou cria se não houver.
 */
export async function upsertConnection(
  tenantId: string,
  input: ConnectionWriteInput,
): Promise<WhatsappConnection> {
  const existing = await getConnectionByTenant(tenantId);
  if (existing) {
    const updated = await updateConnection(tenantId, existing.id, {
      ...input,
      webhookToken: existing.webhook_token,
    });
    return updated as WhatsappConnection;
  }
  return createConnection(tenantId, input);
}

/** Cria conexão já provisionada pelo onboarding embutido (Z-API). */
export async function createOnboardingConnection(
  tenantId: string,
  input: {
    label: string;
    secrets: WhatsappSecrets;
    providerMode: ProviderMode;
    instanceOrigin: InstanceOrigin;
    poolInstanceId?: string | null;
    subscribed: boolean;
    timeoutMinutes: number;
    /** Se informado, reutiliza o token já embutido na URL do provisionamento. */
    webhookToken?: string;
  },
): Promise<WhatsappConnection> {
  const encrypted = encryptSecret(JSON.stringify(input.secrets ?? {}));
  const token = input.webhookToken ?? generateWebhookToken();
  const label = (input.label?.trim() || 'WhatsApp').slice(0, 120);
  const row = await queryOne<ConnectionRow>(
    `INSERT INTO whatsapp_connections
       (tenant_id, provider, label, secrets_encrypted, base_url, is_active, webhook_token,
        provider_mode, instance_origin, connection_status, webhook_configured, zapi_subscribed,
        pool_instance_id, onboarding_started_at, onboarding_expires_at)
     VALUES ($1, 'zapi', $2, $3, $4, true, $5,
             $6, $7, 'PROVISIONING', false, $8,
             $9, NOW(), NOW() + ($10 || ' minutes')::interval)
     RETURNING ${COLS}`,
    [
      tenantId,
      label,
      encrypted,
      'https://api.z-api.io/instances',
      token,
      input.providerMode,
      input.instanceOrigin,
      input.subscribed,
      input.poolInstanceId ?? null,
      String(input.timeoutMinutes),
    ],
  );
  return mapRow(row as ConnectionRow);
}

export async function setConnectionLifecycle(
  tenantId: string,
  id: string,
  status: ConnectionLifecycleStatus,
  detail?: string | null,
): Promise<WhatsappConnection | null> {
  const row = await queryOne<ConnectionRow>(
    `UPDATE whatsapp_connections SET
       connection_status = $3,
       last_status = $4,
       last_status_detail = COALESCE($5, last_status_detail),
       last_status_at = NOW(),
       updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLS}`,
    [
      tenantId,
      id,
      status,
      status === 'CONECTADO' ? 'connected' : status === 'DESCONECTADO' ? 'disconnected' : status.toLowerCase(),
      detail ?? null,
    ],
  );
  return row ? mapRow(row) : null;
}

export async function markWebhookConfigured(
  tenantId: string,
  id: string,
  configured: boolean,
): Promise<void> {
  await query(
    `UPDATE whatsapp_connections
        SET webhook_configured = $3, updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, configured],
  );
}

export async function markZapiSubscribed(
  tenantId: string,
  id: string,
  subscribed: boolean,
): Promise<void> {
  await query(
    `UPDATE whatsapp_connections
        SET zapi_subscribed = $3, updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, subscribed],
  );
}

/** Reanexa credenciais + metadados de onboarding numa conexão existente (reconnect). */
export async function attachOnboardingSecrets(
  tenantId: string,
  id: string,
  input: {
    secrets: WhatsappSecrets;
    providerMode: ProviderMode;
    instanceOrigin: InstanceOrigin;
    poolInstanceId?: string | null;
    subscribed: boolean;
    timeoutMinutes: number;
  },
): Promise<WhatsappConnection | null> {
  const encrypted = encryptSecret(JSON.stringify(input.secrets ?? {}));
  const row = await queryOne<ConnectionRow>(
    `UPDATE whatsapp_connections SET
       secrets_encrypted = $3,
       provider = 'zapi',
       base_url = 'https://api.z-api.io/instances',
       provider_mode = $4,
       instance_origin = $5,
       pool_instance_id = $6,
       zapi_subscribed = $7,
       webhook_configured = false,
       connection_status = 'PROVISIONING',
       onboarding_started_at = NOW(),
       onboarding_expires_at = NOW() + ($8 || ' minutes')::interval,
       updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLS}`,
    [
      tenantId,
      id,
      encrypted,
      input.providerMode,
      input.instanceOrigin,
      input.poolInstanceId ?? null,
      input.subscribed,
      String(input.timeoutMinutes),
    ],
  );
  return row ? mapRow(row) : null;
}

/** Renova a janela do QR/pareamento (após EXPIRADO ou novo QR). */
export async function bumpOnboardingExpiry(
  tenantId: string,
  id: string,
  timeoutMinutes: number,
): Promise<void> {
  await query(
    `UPDATE whatsapp_connections
        SET onboarding_started_at = NOW(),
            onboarding_expires_at = NOW() + ($3 || ' minutes')::interval,
            updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, String(timeoutMinutes)],
  );
}

export async function clearConnectionSecrets(
  tenantId: string,
  id: string,
): Promise<void> {
  const empty = encryptSecret(JSON.stringify({}));
  await query(
    `UPDATE whatsapp_connections
        SET secrets_encrypted = $3,
            connection_status = 'DESCONECTADO',
            phone_number = NULL,
            pool_instance_id = NULL,
            updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, empty],
  );
}

export async function listPoolConnectionsForTenant(tenantId: string): Promise<WhatsappConnection[]> {
  const { rows } = await query<ConnectionRow>(
    `SELECT ${COLS} FROM whatsapp_connections
      WHERE tenant_id = $1 AND instance_origin = 'pool' AND pool_instance_id IS NOT NULL`,
    [tenantId],
  );
  return rows.map(mapRow);
}

export async function listExpiredOnboardings(): Promise<WhatsappConnection[]> {
  const { rows } = await query<ConnectionRow>(
    `SELECT ${COLS} FROM whatsapp_connections
      WHERE connection_status IN ('AGUARDANDO_LEITURA', 'CONECTANDO', 'PROVISIONING')
        AND onboarding_expires_at IS NOT NULL
        AND onboarding_expires_at <= NOW()`,
  );
  return rows.map(mapRow);
}

/** Atualiza só config de IA/lembretes da conexão (sem mexer em credenciais). */
export async function patchConnectionConfig(
  tenantId: string,
  id: string,
  patch: {
    aiPersona?: string | null;
    aiTemperature?: number | null;
    aiMaxTokens?: number | null;
    agentEnabled?: boolean | null;
    reminderAssistantPersona?: string | null;
    memoryScanEnabled?: boolean | null;
    ownerSecretaryEnabled?: boolean | null;
    ownerFreeChatEnabled?: boolean | null;
    ownerWebSearchEnabled?: boolean | null;
  },
): Promise<WhatsappConnection | null> {
  const sets: string[] = [];
  const params: unknown[] = [tenantId, id];
  const push = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.aiPersona !== undefined) {
    push('ai_persona', patch.aiPersona?.trim() || null);
  }
  if (patch.aiTemperature !== undefined) push('ai_temperature', patch.aiTemperature);
  if (patch.aiMaxTokens !== undefined) push('ai_max_tokens', patch.aiMaxTokens);
  if (patch.agentEnabled !== undefined) push('agent_enabled', patch.agentEnabled);
  if (patch.reminderAssistantPersona !== undefined) {
    push('reminder_assistant_persona', patch.reminderAssistantPersona?.trim() || null);
  }
  if (patch.memoryScanEnabled !== undefined) push('memory_scan_enabled', patch.memoryScanEnabled);
  if (patch.ownerSecretaryEnabled !== undefined) {
    push('owner_secretary_enabled', patch.ownerSecretaryEnabled);
  }
  if (patch.ownerFreeChatEnabled !== undefined) {
    push('owner_free_chat_enabled', patch.ownerFreeChatEnabled);
  }
  if (patch.ownerWebSearchEnabled !== undefined) {
    push('owner_web_search_enabled', patch.ownerWebSearchEnabled);
  }

  if (sets.length === 0) return getConnectionById(tenantId, id);

  const row = await queryOne<ConnectionRow>(
    `UPDATE whatsapp_connections SET ${sets.join(', ')}, updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLS}`,
    params,
  );
  return row ? mapRow(row) : null;
}

export async function deleteConnection(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM whatsapp_connections WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

export async function updateConnectionStatusById(
  connectionId: string,
  status: { ok: boolean; detail: string },
): Promise<void> {
  await query(
    `UPDATE whatsapp_connections
        SET last_status = $2, last_status_detail = $3, last_status_at = NOW()
      WHERE id = $1`,
    [connectionId, status.ok ? 'connected' : 'disconnected', status.detail],
  );
}

/** Grava o telefone detectado no provedor (Z-API /device, Meta, etc.). */
export async function updateConnectionPhoneNumber(
  connectionId: string,
  phoneNumber: string,
): Promise<void> {
  const phone = phoneNumber.replace(/\D/g, '').trim();
  if (phone.length < 10) return;
  await query(
    `UPDATE whatsapp_connections
        SET phone_number = $2, updated_at = NOW()
      WHERE id = $1
        AND (phone_number IS NULL OR phone_number <> $2)`,
    [connectionId, phone],
  );
}

/** @deprecated Prefer updateConnectionStatusById. */
export async function updateConnectionStatus(
  tenantId: string,
  status: { ok: boolean; detail: string },
): Promise<void> {
  await query(
    `UPDATE whatsapp_connections
        SET last_status = $2, last_status_detail = $3, last_status_at = NOW()
      WHERE id = (
        SELECT id FROM whatsapp_connections
         WHERE tenant_id = $1
         ORDER BY is_active DESC, created_at ASC
         LIMIT 1
      )`,
    [tenantId, status.ok ? 'connected' : 'disconnected', status.detail],
  );
}
