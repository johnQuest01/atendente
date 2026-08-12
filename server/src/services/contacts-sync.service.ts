/**
 * Sincroniza a agenda do WhatsApp (Z-API GET /contacts) para o CRM (`clients`),
 * para a secretária achar nomes como "Wender" sem a pessoa ter falado antes.
 */

import { env } from '../config/env';
import { logger } from '../config/logger';
import { upsertClientContact } from '../db/queries/clients';
import { getConnectionById } from '../db/queries/whatsapp_connections';
import { AppError } from '../utils/errors';
import {
  fetchAllContacts,
  type ZapiAddressBookContact,
  type ZapiConnection,
} from './zapi.service';

function pickContactName(c: ZapiAddressBookContact): string | null {
  const candidates = [c.name, c.short, c.vname, c.notify];
  for (const raw of candidates) {
    const n = (raw ?? '').trim();
    if (!n) continue;
    if (/^\d{8,}$/.test(n.replace(/\D/g, '')) && n.replace(/\D/g, '').length >= 10) continue;
    return n.slice(0, 120);
  }
  return null;
}

function onlyDigits(v: string): string {
  return v.replace(/\D/g, '');
}

function zapiConnFromDb(conn: NonNullable<Awaited<ReturnType<typeof getConnectionById>>>): ZapiConnection | null {
  if (conn.provider !== 'zapi') return null;
  const instanceId = conn.secrets.instanceId ?? '';
  const token = conn.secrets.token ?? '';
  if (!instanceId || !token) return null;
  return {
    instanceId,
    token,
    clientToken: conn.secrets.clientToken,
    baseUrl: conn.base_url || env.ZAPI_BASE_URL,
  };
}

/**
 * Puxa contatos da Z-API da conexão e faz upsert no CRM.
 * Só Z-API (Evolution/Meta: retorna erro claro).
 */
export async function syncWhatsappContactsToCrm(
  tenantId: string,
  connectionId: string,
): Promise<{
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
}> {
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) throw new AppError('Conexão WhatsApp não encontrada.', 404, 'CONNECTION_NOT_FOUND');

  const zapi = zapiConnFromDb(conn);
  if (!zapi) {
    throw new AppError(
      'Sincronizar agenda só funciona com WhatsApp Z-API conectado neste número.',
      400,
      'CONTACTS_SYNC_ZAPI_ONLY',
    );
  }

  const book = await fetchAllContacts(zapi);
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of book) {
    const phone = onlyDigits(row.phone ?? '');
    if (phone.length < 10 || phone.length > 20) {
      skipped += 1;
      continue;
    }
    const name = pickContactName(row);
    if (!name) {
      skipped += 1;
      continue;
    }
    const result = await upsertClientContact(tenantId, phone, name, { forceName: true });
    if (result === 'created') created += 1;
    else if (result === 'updated') updated += 1;
    else skipped += 1;
  }

  logger.info(
    `Agenda WhatsApp → CRM (${connectionId}): fetched=${book.length} created=${created} updated=${updated} skipped=${skipped}`,
  );

  return { fetched: book.length, created, updated, skipped };
}

/** Best-effort após conectar — não bloqueia o onboarding. */
export function scheduleContactsSync(tenantId: string, connectionId: string): void {
  setTimeout(() => {
    void syncWhatsappContactsToCrm(tenantId, connectionId).catch((err) =>
      logger.warn(`Sync automático de contatos falhou (${connectionId})`, err),
    );
  }, 3_000);
}
