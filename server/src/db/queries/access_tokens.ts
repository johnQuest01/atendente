import crypto from 'node:crypto';
import { assertTenantMatchesScope, query, queryOne } from '../index';
import { decryptSecret, encryptSecret } from '../../utils/crypto';
import type { AccessToken, AccessTokenReveal } from '../../types';

/**
 * Token de acesso por empresa (tenant), emitido pelo dono da plataforma.
 *
 * Segurança em repouso: guardamos SEMPRE três coisas derivadas do token —
 *   - `token_hash` (SHA-256): lookup/verificação sem decifrar;
 *   - `token_encrypted` (AES-256-GCM, mesmo helper das credenciais): para
 *     reexibir ao superadmin e à própria empresa (você pediu que fosse visível);
 *   - `token_prefix` (claro): identificar na UI sem decifrar.
 * O token puro nunca é gravado.
 */

const TOKEN_PREFIX = 'mss_';
const PREFIX_SHOWN = 12;

/** Colunas públicas (sem os segredos), na ordem do tipo AccessToken. */
const PUBLIC_COLS =
  'id, tenant_id, token_prefix, label, created_by, is_active, last_used_at, expires_at, created_at, revoked_at';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Token opaco, fácil de copiar: prefixo fixo + 32 bytes aleatórios (base64url). */
function newTokenValue(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export interface GenerateTokenInput {
  label?: string | null;
  expiresAt?: Date | null;
  createdBy?: string | null;
}

/**
 * Gera um token para a empresa e o retorna em CLARO uma única vez (o chamador
 * mostra no modal "copie agora"). Também desativa tokens ativos anteriores para
 * que só exista um token válido por empresa por vez.
 */
export async function generateAccessToken(
  tenantId: string,
  input: GenerateTokenInput = {},
): Promise<AccessTokenReveal> {
  assertTenantMatchesScope(tenantId);
  const token = newTokenValue();
  const tokenHash = sha256(token);
  const tokenEncrypted = encryptSecret(token);
  const tokenPrefix = token.slice(0, PREFIX_SHOWN);

  // Só um ativo por empresa: revoga os anteriores antes de criar o novo.
  await query(
    `UPDATE access_tokens SET is_active = false, revoked_at = NOW()
      WHERE tenant_id = $1 AND is_active = true`,
    [tenantId],
  );

  const row = await queryOne<AccessToken>(
    `INSERT INTO access_tokens
       (tenant_id, token_hash, token_encrypted, token_prefix, label, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${PUBLIC_COLS}`,
    [
      tenantId,
      tokenHash,
      tokenEncrypted,
      tokenPrefix,
      input.label ?? null,
      input.createdBy ?? null,
      input.expiresAt ? input.expiresAt.toISOString() : null,
    ],
  );
  return { ...(row as AccessToken), token };
}

function isExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

/**
 * Token ATIVO da empresa, decifrado para exibição (card no Settings e "revelar"
 * no painel admin). Retorna null se não houver token ativo/válido.
 */
export async function getTenantAccessToken(tenantId: string): Promise<AccessTokenReveal | null> {
  assertTenantMatchesScope(tenantId);
  const row = await queryOne<AccessToken & { token_encrypted: string }>(
    `SELECT ${PUBLIC_COLS}, token_encrypted FROM access_tokens
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId],
  );
  if (!row || isExpired(row.expires_at)) return null;
  let token: string;
  try {
    token = decryptSecret(row.token_encrypted);
  } catch {
    // Cifra ilegível (ex.: ENCRYPTION_KEY trocada). Não expõe o segredo torto.
    return null;
  }
  const { token_encrypted: _omit, ...pub } = row;
  return { ...(pub as AccessToken), token };
}

/** Histórico de tokens da empresa (sem decifrar; prefixo + status). */
export async function listTenantTokens(tenantId: string): Promise<AccessToken[]> {
  assertTenantMatchesScope(tenantId);
  const { rows } = await query<AccessToken>(
    `SELECT ${PUBLIC_COLS} FROM access_tokens
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows;
}

/** Todos os tokens, agrupáveis por empresa — superadmin (tarefa de sistema). */
export async function listAllAccessTokens(): Promise<AccessToken[]> {
  const { rows } = await query<AccessToken>(
    `SELECT ${PUBLIC_COLS} FROM access_tokens ORDER BY tenant_id, created_at DESC`,
  );
  return rows;
}

/** Revoga um token (superadmin). */
export async function revokeAccessToken(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE access_tokens SET is_active = false, revoked_at = NOW()
      WHERE id = $1 AND is_active = true`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Verifica um token em claro e devolve a empresa dona se ativo/não expirado —
 * pronto para, no futuro, EXIGIR o token como credencial de API. Atualiza
 * `last_used_at`. Roda como tarefa de sistema (lookup por hash global).
 */
export async function verifyAccessToken(
  plaintext: string,
): Promise<{ tokenId: string; tenantId: string } | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const row = await queryOne<{ id: string; tenant_id: string; expires_at: string | null }>(
    `SELECT id, tenant_id, expires_at FROM access_tokens
      WHERE token_hash = $1 AND is_active = true`,
    [sha256(plaintext)],
  );
  if (!row || isExpired(row.expires_at)) return null;
  await query('UPDATE access_tokens SET last_used_at = NOW() WHERE id = $1', [row.id]);
  return { tokenId: row.id, tenantId: row.tenant_id };
}
