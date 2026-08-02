import crypto from 'node:crypto';
import { query, queryOne } from '../index';

/**
 * Convites de acesso à plataforma. Enquanto não existe gateway de pagamento, é
 * assim que uma empresa nova entra: o dono da plataforma gera um link, o cliente
 * abre, cria a própria conta e ganha um período de teste.
 */

export interface TenantInvite {
  id: string;
  token: string;
  email: string | null;
  company_name: string | null;
  trial_days: number;
  ai_message_limit: number | null;
  expires_at: string;
  used_at: string | null;
  tenant_id: string | null;
  created_at: string;
}

/** Linha da lista do super-admin, já com o nome da empresa que aceitou. */
export interface TenantInviteSummary extends TenantInvite {
  tenant_name: string | null;
}

const COLS =
  'id, token, email, company_name, trial_days, ai_message_limit, expires_at, used_at, tenant_id, created_at';

export function generateInviteToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export interface CreateInviteInput {
  email?: string | null;
  companyName?: string | null;
  trialDays: number;
  aiMessageLimit?: number | null;
  /** Validade do LINK (não do teste), em dias. */
  expiresInDays: number;
  createdBy?: string | null;
}

export async function createInvite(input: CreateInviteInput): Promise<TenantInvite> {
  const token = generateInviteToken();
  const row = await queryOne<TenantInvite>(
    `INSERT INTO tenant_invites
       (token, email, company_name, trial_days, ai_message_limit, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::interval, $7)
     RETURNING ${COLS}`,
    [
      token,
      input.email?.toLowerCase() ?? null,
      input.companyName ?? null,
      input.trialDays,
      input.aiMessageLimit ?? null,
      String(input.expiresInDays),
      input.createdBy ?? null,
    ],
  );
  return row as TenantInvite;
}

export async function listInvites(): Promise<TenantInviteSummary[]> {
  const { rows } = await query<TenantInviteSummary>(
    `SELECT i.id, i.token, i.email, i.company_name, i.trial_days, i.ai_message_limit,
            i.expires_at, i.used_at, i.tenant_id, i.created_at,
            t.name AS tenant_name
       FROM tenant_invites i
       LEFT JOIN tenants t ON t.id = i.tenant_id
      ORDER BY i.created_at DESC`,
  );
  return rows;
}

export async function getInviteByToken(token: string): Promise<TenantInvite | null> {
  return queryOne<TenantInvite>(`SELECT ${COLS} FROM tenant_invites WHERE token = $1`, [token]);
}

/** Revoga um convite ainda não usado (expira na hora). */
export async function revokeInvite(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE tenant_invites SET expires_at = NOW()
      WHERE id = $1 AND used_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Marca o convite como usado, vinculando a empresa criada. Só tem efeito se
 * ainda estiver aberto — é o que impede dois aceites simultâneos do mesmo link.
 */
export async function consumeInvite(id: string, tenantId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE tenant_invites
        SET used_at = NOW(), tenant_id = $2
      WHERE id = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}

export function isInviteOpen(invite: TenantInvite): boolean {
  if (invite.used_at) return false;
  return Date.parse(invite.expires_at) > Date.now();
}
