import type { Request } from 'express';
import { z } from 'zod';
import { getConnectionById, type WhatsappConnection } from '../db/queries/whatsapp_connections';
import { AppError } from '../utils/errors';

const connectionIdQuerySchema = z.string().uuid().optional();

/** Lê `?connectionId=` da query (ou undefined). */
export function parseConnectionIdQuery(req: Request): string | undefined {
  const raw = req.query.connectionId;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = connectionIdQuerySchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) {
    throw new AppError('connectionId inválido.', 400, 'VALIDATION');
  }
  return parsed.data;
}

/** Garante que a conexão existe neste tenant. */
export async function requireConnection(
  tenantId: string,
  connectionId: string,
): Promise<WhatsappConnection> {
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) {
    throw new AppError('Número WhatsApp inválido nesta conta.', 400, 'CONNECTION_INVALID');
  }
  return conn;
}
