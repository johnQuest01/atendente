import crypto from 'node:crypto';
import { query, queryOne } from '../index';
import { encryptSecret, decryptSecret } from '../../utils/crypto';

/**
 * Conexões de WhatsApp POR EMPRESA. Um tenant pode ter N instâncias
 * independentes (Z-API / Evolution / Meta Cloud). Cada uma tem webhook próprio
 * e pode ter persona/temperatura/agente próprios (NULL = herda settings do tenant).
 */

export type WhatsappProviderName = 'zapi' | 'evolution' | 'metacloud';

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
  last_status: string | null;
  last_status_detail: string | null;
  last_status_at: string | null;
  created_at?: string;
  updated_at?: string;
}

const COLS = `id, tenant_id, provider, label, phone_number, secrets_encrypted, base_url,
  webhook_token, is_active, ai_persona, ai_temperature, ai_max_tokens, agent_enabled,
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
