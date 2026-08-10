import { listClientsForExport, findOrCreateClient, updateClient } from '../db/queries/clients';
import {
  findOrCreateOpenConversation,
  getConversationMessages,
  listConversationsByClient,
} from '../db/queries/conversations';
import { getConnectionById } from '../db/queries/whatsapp_connections';
import { insertMessage, messageContentExists } from '../db/queries/messages';
import type { Client, MessageDirection } from '../types';

export const CONTACTS_BACKUP_VERSION = 2 as const;

export interface ContactsBackupMessage {
  direction: MessageDirection;
  type?: string;
  content: string | null;
  sent_at?: string | null;
  media_url?: string | null;
  origin?: string | null;
}

export interface ContactsBackupContact {
  phone: string;
  name: string | null;
  company_name?: string | null;
  notes?: string | null;
  ai_prompt?: string | null;
  messages: ContactsBackupMessage[];
}

export interface ContactsBackupFile {
  version: number;
  exported_at: string;
  /** Número/instância de origem — isolamento multi-WhatsApp. */
  connection_id?: string | null;
  connection_phone?: string | null;
  connection_label?: string | null;
  contacts: ContactsBackupContact[];
}

/** Só dígitos; BR 10–11 dígitos ganha prefixo 55. */
export function normalizePhoneDigits(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.length >= 10 && digits.length <= 11 && !digits.startsWith('55')) {
    digits = `55${digits}`;
  }
  return digits;
}

/**
 * Telefone utilizável na agenda/WhatsApp:
 * 55 + DDD (2) + número (8 ou 9) → 12 ou 13 dígitos (ex.: 5511915287476).
 */
export function isExportablePhone(digits: string): boolean {
  return /^55[1-9]\d\d{8,9}$/.test(digits);
}

function usableLabel(value: string | null | undefined): string | null {
  const t = value?.trim() ?? '';
  if (!t || t === '.' || t === '-' || t === '?' || t === 'null') return null;
  return t;
}

function displayNameForClient(c: Client, phone: string): string {
  return usableLabel(c.name) || usableLabel(c.company_name) || phone;
}

function vcfEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** Garante que a conexão existe e é deste tenant (anti-vazamento). */
export async function assertTenantConnection(
  tenantId: string,
  connectionId: string,
): Promise<{ id: string; phone_number: string | null; label: string }> {
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) {
    throw new Error('Número/instância WhatsApp não encontrado nesta conta.');
  }
  return { id: conn.id, phone_number: conn.phone_number, label: conn.label };
}

export interface VcfBuildResult {
  body: string;
  count: number;
  skipped: number;
}

/** Gera VCF (Google Contatos / iPhone) com TEL só dígitos (ex.: 5511915287476). */
export function buildVcf(clients: Client[]): VcfBuildResult {
  const blocks: string[] = [];
  let skipped = 0;
  for (const c of clients) {
    const phone = normalizePhoneDigits(c.phone);
    if (!isExportablePhone(phone)) {
      skipped += 1;
      continue;
    }

    const display = displayNameForClient(c, phone);
    const fn = vcfEscape(display);
    const org = usableLabel(c.company_name);
    blocks.push(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${fn}`,
        `N:${fn};;;;`,
        `TEL;TYPE=CELL:${phone}`,
        org && org !== display ? `ORG:${vcfEscape(org)}` : null,
        usableLabel(c.notes) ? `NOTE:${vcfEscape(usableLabel(c.notes)!)}` : null,
        'END:VCARD',
      ]
        .filter(Boolean)
        .join('\r\n'),
    );
  }
  return {
    body: blocks.join('\r\n') + (blocks.length ? '\r\n' : ''),
    count: blocks.length,
    skipped,
  };
}

export async function buildContactsBackup(
  tenantId: string,
  connectionId: string,
): Promise<ContactsBackupFile> {
  const conn = await assertTenantConnection(tenantId, connectionId);
  const clients = await listClientsForExport(tenantId, connectionId);
  const contacts: ContactsBackupContact[] = [];

  for (const client of clients) {
    const phone = normalizePhoneDigits(client.phone);
    if (!isExportablePhone(phone)) continue;

    const convs = await listConversationsByClient(tenantId, client.id, connectionId);
    const messages: ContactsBackupMessage[] = [];
    for (const conv of convs.slice(0, 3)) {
      const rows = await getConversationMessages(tenantId, conv.id, 500);
      for (const m of rows) {
        if (m.type !== 'text' && !m.content && !m.transcription) {
          if (!m.media_url) continue;
        }
        messages.push({
          direction: m.direction,
          type: m.type,
          content: m.content ?? m.transcription ?? (m.media_url ? `[${m.type}]` : null),
          sent_at: m.sent_at,
          media_url: m.media_url,
          origin: m.origin ?? null,
        });
      }
      if (messages.length > 0) break;
    }

    contacts.push({
      phone,
      name: displayNameForClient(client, phone),
      company_name: usableLabel(client.company_name),
      notes: usableLabel(client.notes),
      ai_prompt: client.ai_prompt,
      messages,
    });
  }

  return {
    version: CONTACTS_BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    connection_id: conn.id,
    connection_phone: conn.phone_number,
    connection_label: conn.label,
    contacts,
  };
}

export interface ImportResult {
  contacts: number;
  messagesInserted: number;
  messagesSkipped: number;
  connectionId: string;
}

async function importMessagesForClient(
  tenantId: string,
  clientId: string,
  messages: ContactsBackupMessage[],
  connectionId: string,
): Promise<{ inserted: number; skipped: number; conversationId: string }> {
  const conversation = await findOrCreateOpenConversation(tenantId, clientId, connectionId);
  if (messages.length === 0) {
    return { inserted: 0, skipped: 0, conversationId: conversation.id };
  }
  let inserted = 0;
  let skipped = 0;
  let cursor = Date.now() - messages.length * 1000;

  for (const msg of messages) {
    const text = (msg.content ?? '').trim();
    if (!text) {
      skipped += 1;
      continue;
    }
    const direction: MessageDirection =
      msg.direction === 'outbound' ? 'outbound' : 'inbound';
    if (await messageContentExists(tenantId, conversation.id, direction, text)) {
      skipped += 1;
      continue;
    }
    let sentAt = msg.sent_at ? new Date(msg.sent_at) : new Date(cursor);
    if (Number.isNaN(sentAt.getTime())) sentAt = new Date(cursor);
    cursor += 1000;

    await insertMessage(tenantId, {
      conversationId: conversation.id,
      direction,
      type: 'text',
      content: text,
      origin: direction === 'inbound' ? 'client' : 'human',
      mediaUrl: msg.media_url ?? null,
      sentAt,
    });
    inserted += 1;
  }
  return { inserted, skipped, conversationId: conversation.id };
}

export async function importContactsBackup(
  tenantId: string,
  backup: ContactsBackupFile,
  connectionId: string,
): Promise<ImportResult> {
  await assertTenantConnection(tenantId, connectionId);

  let contacts = 0;
  let messagesInserted = 0;
  let messagesSkipped = 0;

  for (const item of backup.contacts ?? []) {
    const phone = normalizePhoneDigits(item.phone ?? '');
    if (phone.length < 10) continue;

    const client = await findOrCreateClient(tenantId, phone, item.name ?? null);
    contacts += 1;

    const patch: Parameters<typeof updateClient>[2] = {};
    if (item.name?.trim() && !client.name) patch.name = item.name.trim();
    if (item.company_name?.trim()) patch.company_name = item.company_name.trim();
    if (item.notes?.trim()) patch.notes = item.notes.trim();
    if (item.ai_prompt?.trim()) patch.ai_prompt = item.ai_prompt.trim();
    if (Object.keys(patch).length > 0) {
      await updateClient(tenantId, client.id, patch);
    }

    const r = await importMessagesForClient(
      tenantId,
      client.id,
      item.messages ?? [],
      connectionId,
    );
    messagesInserted += r.inserted;
    messagesSkipped += r.skipped;
  }

  return { contacts, messagesInserted, messagesSkipped, connectionId };
}

export async function pasteImportConversation(
  tenantId: string,
  input: {
    phone: string;
    name?: string | null;
    connectionId: string;
    messages: Array<{ direction: MessageDirection; text: string }>;
  },
): Promise<{ client: Client; conversationId: string; inserted: number; skipped: number }> {
  await assertTenantConnection(tenantId, input.connectionId);

  const phone = normalizePhoneDigits(input.phone);
  if (phone.length < 10) {
    throw new Error('Telefone inválido. Use DDI+DDD+número, ex.: 5511915287476.');
  }

  const client = await findOrCreateClient(tenantId, phone, input.name ?? null);
  if (input.name?.trim() && !client.name) {
    await updateClient(tenantId, client.id, { name: input.name.trim() });
  }

  const mapped: ContactsBackupMessage[] = input.messages.map((m) => ({
    direction: m.direction,
    content: m.text,
    type: 'text',
  }));
  const r = await importMessagesForClient(tenantId, client.id, mapped, input.connectionId);

  return {
    client,
    conversationId: r.conversationId,
    inserted: r.inserted,
    skipped: r.skipped,
  };
}

/** Type guard leve do JSON de backup. */
export function isContactsBackupFile(value: unknown): value is ContactsBackupFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as ContactsBackupFile;
  return Array.isArray(v.contacts);
}
