import crypto from 'node:crypto';
import { query, queryOne } from '../index';
import { encryptSecret, decryptSecret } from '../../utils/crypto';

/**
 * Conexao de WhatsApp POR EMPRESA (tenant). Cada empresa traz a propria
 * instancia (Z-API/Evolution). As credenciais ficam cifradas em
 * `secrets_encrypted` (AES-256-GCM) e o webhook e roteado por `webhook_token`.
 */

export type WhatsappProviderName = 'zapi' | 'evolution' | 'metacloud';

export interface WhatsappSecrets {
  // Z-API
  instanceId?: string;
  token?: string;
  clientToken?: string;
  // Evolution API
  apiKey?: string;
  instance?: string;
  // Meta Cloud API
  accessToken?: string;
  phoneNumberId?: string;
}

export interface WhatsappConnection {
  id: string;
  tenant_id: string;
  provider: WhatsappProviderName;
  base_url: string | null;
  webhook_token: string;
  is_active: boolean;
  last_status: string | null;
  last_status_detail: string | null;
  last_status_at: string | null;
  secrets: WhatsappSecrets;
}

interface ConnectionRow {
  id: string;
  tenant_id: string;
  provider: WhatsappProviderName;
  secrets_encrypted: string | null;
  base_url: string | null;
  webhook_token: string;
  is_active: boolean;
  last_status: string | null;
  last_status_detail: string | null;
  last_status_at: string | null;
}

const COLS =
  'id, tenant_id, provider, secrets_encrypted, base_url, webhook_token, is_active, last_status, last_status_detail, last_status_at';

function decodeSecrets(enc: string | null): WhatsappSecrets {
  if (!enc) return {};
  try {
    return JSON.parse(decryptSecret(enc)) as WhatsappSecrets;
  } catch {
    // Chave trocada/credencial corrompida: trata como "sem credenciais" em vez
    // de derrubar o fluxo (o envio cai no modo simulado/desconfigurado).
    return {};
  }
}

function mapRow(row: ConnectionRow): WhatsappConnection {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    provider: row.provider,
    base_url: row.base_url,
    webhook_token: row.webhook_token,
    is_active: row.is_active,
    last_status: row.last_status,
    last_status_detail: row.last_status_detail,
    last_status_at: row.last_status_at,
    secrets: decodeSecrets(row.secrets_encrypted),
  };
}

/** Gera um token opaco para a URL de webhook desta empresa. */
export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export async function getConnectionByTenant(tenantId: string): Promise<WhatsappConnection | null> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${COLS} FROM whatsapp_connections WHERE tenant_id = $1`,
    [tenantId],
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

export interface UpsertConnectionInput {
  provider: WhatsappProviderName;
  secrets: WhatsappSecrets;
  baseUrl?: string | null;
  isActive?: boolean;
  /**
   * Token de webhook explicito. So e usado na CRIACAO; numa atualizacao o token
   * existente e preservado (a URL configurada na Z-API continua valendo).
   */
  webhookToken?: string;
}

/**
 * Cria ou atualiza a conexao da empresa (1 por tenant). Cifra os segredos.
 * Na atualizacao, mantem o `webhook_token` ja existente (URL estavel).
 */
export async function upsertConnection(
  tenantId: string,
  input: UpsertConnectionInput,
): Promise<WhatsappConnection> {
  const encrypted = encryptSecret(JSON.stringify(input.secrets ?? {}));
  const token = input.webhookToken ?? generateWebhookToken();
  const row = await queryOne<ConnectionRow>(
    `INSERT INTO whatsapp_connections
       (tenant_id, provider, secrets_encrypted, base_url, is_active, webhook_token)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       secrets_encrypted = EXCLUDED.secrets_encrypted,
       base_url = EXCLUDED.base_url,
       is_active = EXCLUDED.is_active,
       updated_at = NOW()
     RETURNING ${COLS}`,
    [tenantId, input.provider, encrypted, input.baseUrl ?? null, input.isActive ?? true, token],
  );
  return mapRow(row as ConnectionRow);
}

/** Atualiza o cache do ultimo status de conexao consultado. */
export async function updateConnectionStatus(
  tenantId: string,
  status: { ok: boolean; detail: string },
): Promise<void> {
  await query(
    `UPDATE whatsapp_connections
        SET last_status = $2, last_status_detail = $3, last_status_at = NOW()
      WHERE tenant_id = $1`,
    [tenantId, status.ok ? 'connected' : 'disconnected', status.detail],
  );
}
