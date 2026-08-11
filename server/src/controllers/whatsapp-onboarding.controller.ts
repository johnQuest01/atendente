import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  activateTenantPaid,
  disconnectWhatsapp,
  pollConnectionStatus,
  refreshQr,
  requestPhoneCode,
  restartWhatsappConnect,
  startWhatsappConnect,
} from '../services/whatsapp-onboarding.service';
import { getConnectionById } from '../db/queries/whatsapp_connections';
import { AppError, NotFoundError } from '../utils/errors';
import { env } from '../config/env';

/**
 * Endpoints do onboarding embutido.
 * O cliente NUNCA vê o painel Z-API — só o nosso backend.
 *
 * Rotas montadas em:
 * - POST   /api/whatsapp/connect
 * - GET    /api/whatsapp/connect/:connectionId/qr
 * - POST   /api/whatsapp/connect/:connectionId/phone-code
 * - GET    /api/whatsapp/connect/:connectionId/status
 * - POST   /api/whatsapp/connect/:connectionId/disconnect
 * - POST   /api/tenants/:tenantId/whatsapp/connect  (alias do prompt)
 * - POST   /api/tenants/:tenantId/whatsapp/activate-paid (assina instâncias)
 */

export const connectBodySchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  /** web = aparelhos conectados (padrão); phoneless = número dedicado / mobile. */
  providerMode: z.enum(['web', 'phoneless']).optional().default('web'),
  /** Número com DDI — gera código de pareamento na hora (fluxo principal). */
  phone: z.string().trim().min(10).max(20).optional(),
});

export const connectionIdParamSchema = z.object({
  connectionId: z.string().uuid(),
});

export const tenantIdParamSchema = z.object({
  tenantId: z.string().uuid(),
});

export const phoneCodeBodySchema = z.object({
  phone: z.string().trim().min(10).max(20),
});

function assertTenantAccess(req: Request, tenantId: string): void {
  if (req.user!.role === 'superadmin') return;
  if (req.user!.tenant_id !== tenantId) {
    throw new AppError('Sem permissão para esta empresa.', 403, 'FORBIDDEN');
  }
}

export async function postConnect(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const body = req.body as z.infer<typeof connectBodySchema>;
  const result = await startWhatsappConnect(tenantId, {
    label: body.label,
    providerMode: body.providerMode,
    phone: body.phone,
  });
  const byCode = Boolean(result.phoneCode);
  res.status(201).json({
    connectionId: result.connection.id,
    label: result.connection.label,
    status: result.status,
    qrBase64: result.qrBase64,
    phoneCode: result.phoneCode,
    phone: result.phone,
    providerMode: result.providerMode,
    phonelessWarning: result.phonelessWarning,
    webhookConfigured: result.connection.webhook_configured,
    timeoutMinutes: env.WHATSAPP_ONBOARDING_TIMEOUT_MINUTES,
    instructions: byCode
      ? 'No celular: WhatsApp → Aparelhos conectados → Conectar com número de telefone → digite o código.'
      : 'No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o QR.',
  });
}

/** Alias do prompt: POST /tenants/:tenantId/whatsapp/connect */
export async function postConnectForTenant(req: Request, res: Response): Promise<void> {
  const { tenantId } = req.params as z.infer<typeof tenantIdParamSchema>;
  assertTenantAccess(req, tenantId);
  // Temporariamente assume o tenant do path (já validado).
  const original = req.user!.tenant_id;
  req.user!.tenant_id = tenantId;
  try {
    await postConnect(req, res);
  } finally {
    req.user!.tenant_id = original;
  }
}

export async function getConnectQr(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { connectionId } = req.params as z.infer<typeof connectionIdParamSchema>;
  const result = await refreshQr(tenantId, connectionId);
  res.json(result);
}

export async function postPhoneCode(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { connectionId } = req.params as z.infer<typeof connectionIdParamSchema>;
  const { phone } = req.body as z.infer<typeof phoneCodeBodySchema>;
  const result = await requestPhoneCode(tenantId, connectionId, phone);
  res.json(result);
}

export async function getConnectStatus(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { connectionId } = req.params as z.infer<typeof connectionIdParamSchema>;
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) throw new NotFoundError('Conexão');
  const polled = await pollConnectionStatus(tenantId, connectionId);
  res.json({
    connectionId,
    status: polled.status,
    phone: polled.phone ?? conn.phone_number,
    connected: polled.connected,
    webhookConfigured: conn.webhook_configured,
    providerMode: conn.provider_mode,
    instanceOrigin: conn.instance_origin,
    expiresAt: conn.onboarding_expires_at,
  });
}

export async function postDisconnect(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { connectionId } = req.params as z.infer<typeof connectionIdParamSchema>;
  await disconnectWhatsapp(tenantId, connectionId);
  res.json({ ok: true, status: 'DESCONECTADO' });
}

/** Reconecta (novo QR) numa conexão já existente. */
export async function postReconnect(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { connectionId } = req.params as z.infer<typeof connectionIdParamSchema>;
  const body = (req.body ?? {}) as z.infer<typeof connectBodySchema>;
  const result = await restartWhatsappConnect(tenantId, connectionId, {
    label: body.label,
    providerMode: body.providerMode,
    phone: body.phone,
  });
  const byCode = Boolean(result.phoneCode);
  res.json({
    connectionId: result.connection.id,
    label: result.connection.label,
    status: result.status,
    qrBase64: result.qrBase64,
    phoneCode: result.phoneCode,
    phone: result.phone,
    providerMode: result.providerMode,
    phonelessWarning: result.phonelessWarning,
    webhookConfigured: result.connection.webhook_configured,
    timeoutMinutes: env.WHATSAPP_ONBOARDING_TIMEOUT_MINUTES,
    instructions: byCode
      ? 'No celular: WhatsApp → Aparelhos conectados → Conectar com número de telefone → digite o código.'
      : 'No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o QR.',
  });
}

/** Marca conta como pagante e assina instâncias on-demand. */
export async function postActivatePaid(req: Request, res: Response): Promise<void> {
  const { tenantId } = req.params as z.infer<typeof tenantIdParamSchema>;
  assertTenantAccess(req, tenantId);
  if (req.user!.role !== 'superadmin' && req.user!.role !== 'admin') {
    throw new AppError('Apenas admin pode ativar o plano.', 403, 'FORBIDDEN');
  }
  await activateTenantPaid(tenantId);
  res.json({ ok: true, accountStatus: 'active' });
}
