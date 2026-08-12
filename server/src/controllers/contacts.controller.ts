import type { Request, Response } from 'express';
import { z } from 'zod';
import { listClientsForExport } from '../db/queries/clients';
import {
  assertTenantConnection,
  buildContactsBackup,
  buildVcf,
  importContactsBackup,
  isContactsBackupFile,
  pasteImportConversation,
} from '../services/contacts-export.service';
import { syncWhatsappContactsToCrm } from '../services/contacts-sync.service';
import { AppError } from '../utils/errors';

const connectionQuerySchema = z.object({
  connectionId: z.string().uuid({ message: 'Informe o número WhatsApp (connectionId).' }),
});

export async function exportContactsVcf(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const parsed = connectionQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new AppError('Escolha de qual número WhatsApp baixar a agenda.', 400, 'CONNECTION_REQUIRED');
  }
  const { connectionId } = parsed.data;
  await assertTenantConnection(tenantId, connectionId);

  const clients = await listClientsForExport(tenantId, connectionId);
  const { body, count, skipped } = buildVcf(clients);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="contatos-whatsapp-${stamp}.vcf"`,
  );
  res.setHeader('X-Contacts-Count', String(count));
  res.setHeader('X-Contacts-Skipped', String(skipped));
  res.setHeader('X-Connection-Id', connectionId);
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Contacts-Count, X-Contacts-Skipped, X-Connection-Id, Content-Disposition',
  );
  res.send(body);
}

export async function exportContactsJson(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const parsed = connectionQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new AppError(
      'Escolha de qual número WhatsApp baixar o histórico.',
      400,
      'CONNECTION_REQUIRED',
    );
  }
  const { connectionId } = parsed.data;
  const backup = await buildContactsBackup(tenantId, connectionId);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="conversas-backup-${stamp}.json"`,
  );
  res.setHeader('X-Connection-Id', connectionId);
  res.setHeader('Access-Control-Expose-Headers', 'X-Connection-Id, Content-Disposition');
  res.json(backup);
}

export const importBodySchema = z.object({
  connectionId: z.string().uuid(),
  backup: z.unknown(),
});

export async function importContactsJson(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const body = req.body as Record<string, unknown> | null;
  const connectionId =
    typeof body?.connectionId === 'string'
      ? body.connectionId
      : typeof req.query.connectionId === 'string'
        ? req.query.connectionId
        : null;
  if (!connectionId || !z.string().uuid().safeParse(connectionId).success) {
    throw new AppError(
      'Escolha em qual número WhatsApp importar o JSON.',
      400,
      'CONNECTION_REQUIRED',
    );
  }

  let backup: unknown = body?.backup;
  if (backup === undefined && body && Array.isArray(body.contacts)) {
    const { connectionId: _omit, ...rest } = body;
    backup = rest;
  }

  if (!isContactsBackupFile(backup)) {
    throw new AppError(
      'Arquivo inválido. Use o JSON exportado por “Baixar conversas”.',
      400,
      'INVALID_BACKUP',
    );
  }

  try {
    const result = await importContactsBackup(tenantId, backup, connectionId);
    res.json({
      ok: true,
      ...result,
      detail: `${result.contacts} contato(s), ${result.messagesInserted} mensagem(ns) novas, ${result.messagesSkipped} ignorada(s) neste número.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, 400, 'IMPORT_FAILED');
  }
}

/**
 * Puxa a agenda do WhatsApp (Z-API) para o CRM — nomes ficam buscáveis pela IA.
 */
export async function syncWhatsappContacts(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const parsed = connectionQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new AppError(
      'Escolha de qual número WhatsApp sincronizar a agenda.',
      400,
      'CONNECTION_REQUIRED',
    );
  }
  const { connectionId } = parsed.data;
  await assertTenantConnection(tenantId, connectionId);
  const result = await syncWhatsappContactsToCrm(tenantId, connectionId);
  res.json({
    ok: true,
    ...result,
    detail:
      result.fetched === 0
        ? 'Nenhum contato retornado pela Z-API. Confira se o WhatsApp está conectado e tem agenda.'
        : `Agenda sincronizada: ${result.created} novo(s), ${result.updated} nome(s) atualizado(s), ${result.skipped} ignorado(s) (${result.fetched} lidos).`,
  });
}

export const pasteImportSchema = z.object({
  connectionId: z.string().uuid(),
  phone: z.string().trim().min(8).max(30),
  name: z.string().trim().max(120).optional().nullable(),
  messages: z
    .array(
      z.object({
        direction: z.enum(['inbound', 'outbound']),
        text: z.string().trim().min(1).max(4096),
      }),
    )
    .min(1)
    .max(500),
});

export async function pasteImport(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const input = req.body as z.infer<typeof pasteImportSchema>;
  try {
    const result = await pasteImportConversation(tenantId, {
      phone: input.phone,
      name: input.name,
      connectionId: input.connectionId,
      messages: input.messages,
    });
    res.status(201).json({
      ok: true,
      client: result.client,
      conversationId: result.conversationId,
      inserted: result.inserted,
      skipped: result.skipped,
      detail: `${result.inserted} mensagem(ns) salvas neste WhatsApp para a IA.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, 400, 'PASTE_IMPORT_FAILED');
  }
}
