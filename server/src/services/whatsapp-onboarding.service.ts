import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';
import { hasEncryptionKey } from '../utils/crypto';
import {
  bindPoolToConnection,
  getProvisionerForTenant,
} from './zapi/InstanceProvisioner';
import { zapiClient } from './zapi/ZApiClient';
import { releasePoolInstance } from '../db/queries/instance_pool';
import {
  clearConnectionSecrets,
  attachOnboardingSecrets,
  bumpOnboardingExpiry,
  createOnboardingConnection,
  generateWebhookToken,
  getConnectionById,
  listConnections,
  listExpiredOnboardings,
  listPoolConnectionsForTenant,
  markWebhookConfigured,
  markZapiSubscribed,
  setConnectionLifecycle,
  updateConnectionPhoneNumber,
  type ConnectionLifecycleStatus,
  type ProviderMode,
  type WhatsappConnection,
} from '../db/queries/whatsapp_connections';
import { fetchDevicePhone } from './zapi.service';
import {
  listExpiredTrialTenants,
  setTenantAccountStatus,
  updateTenant,
} from '../db/queries/tenants';
import { emitWhatsappStatus } from '../socket';
import { invalidateTenantWhatsapp } from './whatsapp.service';

export interface ConnectStartInput {
  label?: string;
  providerMode?: ProviderMode;
  /** Número com DDI — fluxo principal: gera código de pareamento na hora. */
  phone?: string;
}

function webhookUrlFor(webhookToken: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhook/whatsapp/${webhookToken}`;
}

function credsOf(conn: WhatsappConnection) {
  const instanceId = conn.secrets.instanceId;
  const token = conn.secrets.token;
  if (!instanceId || !token) {
    throw new AppError('Conexão sem credenciais Z-API.', 400, 'NO_CREDS');
  }
  return { instanceId, token };
}

async function pushStatus(
  tenantId: string,
  connectionId: string,
  status: ConnectionLifecycleStatus,
  extra?: { detail?: string; phone?: string | null; qrBase64?: string | null; phoneCode?: string | null },
): Promise<void> {
  await setConnectionLifecycle(tenantId, connectionId, status, extra?.detail ?? null);
  emitWhatsappStatus(tenantId, {
    connectionId,
    status,
    detail: extra?.detail ?? null,
    phone: extra?.phone ?? null,
    qrBase64: extra?.qrBase64 ?? null,
    phoneCode: extra?.phoneCode ?? null,
  });
}

/**
 * 1) Provisiona instância (pool se trial, on-demand se pago).
 * 2) Persiste conexão cifrada.
 * 3) Configura webhooks.
 * 4) Se veio `phone`, gera código de pareamento (fluxo principal); senão QR.
 */
export async function startWhatsappConnect(
  tenantId: string,
  input: ConnectStartInput = {},
): Promise<{
  connection: WhatsappConnection;
  qrBase64: string | null;
  phoneCode: string | null;
  phone: string | null;
  status: ConnectionLifecycleStatus;
  providerMode: ProviderMode;
  phonelessWarning: boolean;
}> {
  if (!hasEncryptionKey()) {
    throw new AppError(
      'Defina ENCRYPTION_KEY no servidor para salvar a conexão com segurança.',
      503,
      'ENCRYPTION_MISSING',
    );
  }

  const providerMode: ProviderMode = input.providerMode ?? 'web';
  const label = (input.label?.trim() || 'WhatsApp').slice(0, 120);
  const phoneDigits = input.phone?.replace(/\D/g, '') || null;
  if (phoneDigits && phoneDigits.length < 10) {
    throw new AppError('Informe o número com DDI (ex.: 5511999999999).', 400, 'BAD_PHONE');
  }

  // Token de webhook antecipado — mesma URL na criação Z-API e no banco.
  const webhookToken = generateWebhookToken();
  const webhookUrl = webhookUrlFor(webhookToken);

  const { provisioner, tenant } = await getProvisionerForTenant(tenantId);
  if (tenant.account_status === 'expired') {
    throw new AppError(
      'Seu período de teste terminou. Fale com o suporte para reativar a conta.',
      402,
      'TRIAL_EXPIRED',
    );
  }

  let provisioned;
  try {
    provisioned = await provisioner.provision({
      tenantId,
      tenantName: tenant.name,
      label,
      providerMode,
      webhookUrl,
    });
  } catch (err) {
    logger.warn('Falha ao provisionar instância WhatsApp', err);
    throw err instanceof AppError
      ? err
      : new AppError('Não foi possível criar a conexão WhatsApp.', 502, 'PROVISION_FAILED');
  }

  const connection = await createOnboardingConnection(tenantId, {
    label,
    secrets: {
      instanceId: provisioned.instanceId,
      token: provisioned.token,
      clientToken: provisioned.clientToken,
    },
    providerMode,
    instanceOrigin: provisioned.origin,
    poolInstanceId: provisioned.poolInstanceId ?? null,
    subscribed: provisioned.subscribed,
    timeoutMinutes: env.WHATSAPP_ONBOARDING_TIMEOUT_MINUTES,
    webhookToken,
  });

  if (provisioned.poolInstanceId) {
    await bindPoolToConnection(provisioned.poolInstanceId, connection.id);
  }

  try {
    await zapiClient.configureEveryWebhook(credsOf(connection), webhookUrl, true);
    await markWebhookConfigured(tenantId, connection.id, true);
  } catch (err) {
    logger.warn('Webhook não configurado na criação — tentaremos de novo ao conectar', err);
  }

  let phoneCode: string | null = null;
  let qrBase64: string | null = null;

  // Fluxo principal: número → código de pareamento.
  if (phoneDigits) {
    try {
      const result = await zapiClient.getPhoneCode(credsOf(connection), phoneDigits);
      if (result.challenge) {
        await pushStatus(tenantId, connection.id, 'ERRO', {
          detail:
            'Este aparelho pediu verificação extra (passkey). Tente o QR Code ou outro número.',
        });
        const updated = await getConnectionById(tenantId, connection.id);
        return {
          connection: updated ?? connection,
          qrBase64: null,
          phoneCode: null,
          phone: phoneDigits,
          status: 'ERRO',
          providerMode,
          phonelessWarning: providerMode === 'phoneless',
        };
      }
      phoneCode = result.code;
      if (!phoneCode) {
        throw new AppError('A Z-API não devolveu o código.', 502, 'NO_CODE');
      }
      await pushStatus(tenantId, connection.id, 'AGUARDANDO_LEITURA', {
        detail: 'Digite este código no WhatsApp do celular',
        phone: phoneDigits,
        phoneCode,
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'NO_CODE') throw err;
      logger.warn('Código de pareamento inicial falhou — fallback QR', err);
    }
  }

  // QR: pedido explícito sem número, ou fallback se o código falhou.
  if (!phoneCode) {
    try {
      const qr = await zapiClient.getQrCodeImage(credsOf(connection));
      qrBase64 = qr.imageBase64;
      if (qr.challenge) {
        await pushStatus(tenantId, connection.id, 'ERRO', {
          detail:
            'Este aparelho pediu verificação extra (passkey). Use o pareamento por código ou tente de novo.',
        });
        const updated = await getConnectionById(tenantId, connection.id);
        return {
          connection: updated ?? connection,
          qrBase64: null,
          phoneCode: null,
          phone: phoneDigits,
          status: 'ERRO',
          providerMode,
          phonelessWarning: providerMode === 'phoneless',
        };
      }
    } catch (err) {
      logger.warn('QR inicial falhou', err);
    }

    await pushStatus(tenantId, connection.id, 'AGUARDANDO_LEITURA', {
      detail: phoneDigits
        ? 'Não foi possível gerar o código — escaneie o QR abaixo'
        : 'Abra o WhatsApp → Aparelhos conectados → Conectar aparelho',
      phone: phoneDigits,
      qrBase64,
    });
  }

  const updated = await getConnectionById(tenantId, connection.id);
  return {
    connection: updated ?? connection,
    qrBase64,
    phoneCode,
    phone: phoneDigits,
    status: 'AGUARDANDO_LEITURA',
    providerMode,
    phonelessWarning: providerMode === 'phoneless',
  };
}

export async function refreshQr(tenantId: string, connectionId: string) {
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) throw new AppError('Conexão não encontrada.', 404, 'NOT_FOUND');
  if (!conn.secrets.instanceId || !conn.secrets.token) {
    throw new AppError(
      'Esta conexão não tem instância ativa. Use reconectar para provisionar de novo.',
      400,
      'NO_CREDS',
    );
  }
  await bumpOnboardingExpiry(tenantId, connectionId, env.WHATSAPP_ONBOARDING_TIMEOUT_MINUTES);
  const qr = await zapiClient.getQrCodeImage(credsOf(conn));
  if (qr.challenge) {
    await pushStatus(tenantId, connectionId, 'ERRO', {
      detail: 'Aparelho pediu passkey. Tente o código por número.',
    });
    return { qrBase64: null as string | null, challenge: true };
  }
  await pushStatus(tenantId, connectionId, 'AGUARDANDO_LEITURA', {
    detail: 'Novo QR gerado — escaneie no WhatsApp',
    qrBase64: qr.imageBase64,
  });
  return { qrBase64: qr.imageBase64, challenge: false };
}

/**
 * Reconecta uma conexão existente.
 * Com `phone`: gera código de pareamento.
 * Sem credenciais: re-provisiona na mesma linha.
 */
export async function restartWhatsappConnect(
  tenantId: string,
  connectionId: string,
  input: ConnectStartInput = {},
): Promise<{
  connection: WhatsappConnection;
  qrBase64: string | null;
  phoneCode: string | null;
  phone: string | null;
  status: ConnectionLifecycleStatus;
  providerMode: ProviderMode;
  phonelessWarning: boolean;
}> {
  const existing = await getConnectionById(tenantId, connectionId);
  if (!existing) throw new AppError('Conexão não encontrada.', 404, 'NOT_FOUND');

  const phoneDigits = input.phone?.replace(/\D/g, '') || null;
  if (phoneDigits && phoneDigits.length < 10) {
    throw new AppError('Informe o número com DDI (ex.: 5511999999999).', 400, 'BAD_PHONE');
  }

  // Já tem instância: só gera código (ou QR se não veio número).
  if (existing.secrets.instanceId && existing.secrets.token) {
    if (phoneDigits) {
      const code = await requestPhoneCode(tenantId, connectionId, phoneDigits);
      const updated = await getConnectionById(tenantId, connectionId);
      return {
        connection: updated ?? existing,
        qrBase64: null,
        phoneCode: code.code,
        phone: phoneDigits,
        status: (updated?.connection_status ?? 'AGUARDANDO_LEITURA') as ConnectionLifecycleStatus,
        providerMode: existing.provider_mode,
        phonelessWarning: existing.provider_mode === 'phoneless',
      };
    }
    const qr = await refreshQr(tenantId, connectionId);
    const updated = await getConnectionById(tenantId, connectionId);
    return {
      connection: updated ?? existing,
      qrBase64: qr.qrBase64,
      phoneCode: null,
      phone: null,
      status: (updated?.connection_status ?? 'AGUARDANDO_LEITURA') as ConnectionLifecycleStatus,
      providerMode: existing.provider_mode,
      phonelessWarning: existing.provider_mode === 'phoneless',
    };
  }

  if (!hasEncryptionKey()) {
    throw new AppError(
      'Defina ENCRYPTION_KEY no servidor para salvar a conexão com segurança.',
      503,
      'ENCRYPTION_MISSING',
    );
  }

  const providerMode: ProviderMode =
    input.providerMode ?? existing.provider_mode ?? 'web';
  const label = (input.label?.trim() || existing.label || 'WhatsApp').slice(0, 120);
  const webhookUrl = webhookUrlFor(existing.webhook_token);

  const { provisioner, tenant } = await getProvisionerForTenant(tenantId);
  if (tenant.account_status === 'expired') {
    throw new AppError(
      'Seu período de teste terminou. Fale com o suporte para reativar a conta.',
      402,
      'TRIAL_EXPIRED',
    );
  }

  let provisioned;
  try {
    provisioned = await provisioner.provision({
      tenantId,
      tenantName: tenant.name,
      label,
      providerMode,
      webhookUrl,
    });
  } catch (err) {
    logger.warn('Falha ao re-provisionar WhatsApp', err);
    throw err instanceof AppError
      ? err
      : new AppError('Não foi possível reconectar o WhatsApp.', 502, 'PROVISION_FAILED');
  }

  const connection = await attachOnboardingSecrets(tenantId, connectionId, {
    secrets: {
      instanceId: provisioned.instanceId,
      token: provisioned.token,
      clientToken: provisioned.clientToken,
    },
    providerMode,
    instanceOrigin: provisioned.origin,
    poolInstanceId: provisioned.poolInstanceId ?? null,
    subscribed: provisioned.subscribed,
    timeoutMinutes: env.WHATSAPP_ONBOARDING_TIMEOUT_MINUTES,
  });
  if (!connection) throw new AppError('Conexão não encontrada.', 404, 'NOT_FOUND');

  if (provisioned.poolInstanceId) {
    await bindPoolToConnection(provisioned.poolInstanceId, connection.id);
  }

  try {
    await zapiClient.configureEveryWebhook(credsOf(connection), webhookUrl, true);
    await markWebhookConfigured(tenantId, connection.id, true);
  } catch (err) {
    logger.warn('Webhook no reconnect falhou — tentaremos ao conectar', err);
  }

  let phoneCode: string | null = null;
  let qrBase64: string | null = null;

  if (phoneDigits) {
    try {
      const result = await zapiClient.getPhoneCode(credsOf(connection), phoneDigits);
      phoneCode = result.code;
      if (phoneCode) {
        await pushStatus(tenantId, connection.id, 'AGUARDANDO_LEITURA', {
          detail: 'Digite este código no WhatsApp do celular',
          phone: phoneDigits,
          phoneCode,
        });
      }
    } catch (err) {
      logger.warn('Código no reconnect falhou — fallback QR', err);
    }
  }

  if (!phoneCode) {
    try {
      const qr = await zapiClient.getQrCodeImage(credsOf(connection));
      qrBase64 = qr.imageBase64;
    } catch (err) {
      logger.warn('QR no reconnect falhou', err);
    }
    await pushStatus(tenantId, connection.id, 'AGUARDANDO_LEITURA', {
      detail: 'Abra o WhatsApp → Aparelhos conectados → Conectar aparelho',
      phone: phoneDigits,
      qrBase64,
    });
  }

  const updated = await getConnectionById(tenantId, connection.id);
  return {
    connection: updated ?? connection,
    qrBase64,
    phoneCode,
    phone: phoneDigits,
    status: 'AGUARDANDO_LEITURA',
    providerMode,
    phonelessWarning: providerMode === 'phoneless',
  };
}

export async function requestPhoneCode(tenantId: string, connectionId: string, phone: string) {
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) throw new AppError('Conexão não encontrada.', 404, 'NOT_FOUND');
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) {
    throw new AppError('Informe o número com DDI (ex.: 5511999999999).', 400, 'BAD_PHONE');
  }
  const result = await zapiClient.getPhoneCode(credsOf(conn), digits);
  if (result.challenge) {
    throw new AppError(
      'Este aparelho pediu verificação extra. Tente o QR Code.',
      400,
      'PASSKEY_REQUIRED',
    );
  }
  if (!result.code) {
    throw new AppError('A Z-API não devolveu o código.', 502, 'NO_CODE');
  }
  await pushStatus(tenantId, connectionId, 'AGUARDANDO_LEITURA', {
    detail: 'Digite este código no WhatsApp do celular',
    phoneCode: result.code,
  });
  return { code: result.code };
}

export async function pollConnectionStatus(tenantId: string, connectionId: string) {
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) throw new AppError('Conexão não encontrada.', 404, 'NOT_FOUND');

  if (
    conn.onboarding_expires_at &&
    Date.parse(conn.onboarding_expires_at) <= Date.now() &&
    conn.connection_status !== 'CONECTADO'
  ) {
    await pushStatus(tenantId, connectionId, 'EXPIRADO', {
      detail: 'Tempo esgotado. Gere um novo QR para tentar de novo.',
    });
    return { status: 'EXPIRADO' as const, phone: null as string | null, connected: false };
  }

  const status = await zapiClient.getStatus(credsOf(conn));
  if (status.connected && status.smartphoneConnected) {
    await finalizeConnected(tenantId, conn);
    const fresh = await getConnectionById(tenantId, connectionId);
    return {
      status: 'CONECTADO' as const,
      phone: fresh?.phone_number ?? null,
      connected: true,
    };
  }

  if (conn.connection_status === 'PROVISIONING') {
    await pushStatus(tenantId, connectionId, 'AGUARDANDO_LEITURA');
  } else if (
    conn.connection_status !== 'AGUARDANDO_LEITURA' &&
    conn.connection_status !== 'CONECTANDO'
  ) {
    // mantém
  } else {
    await pushStatus(tenantId, connectionId, 'AGUARDANDO_LEITURA', {
      detail: status.detail,
    });
  }

  return {
    status: (await getConnectionById(tenantId, connectionId))?.connection_status ?? 'AGUARDANDO_LEITURA',
    phone: null as string | null,
    connected: false,
  };
}

/** Chamado pelo webhook de conexão ou pelo poll bem-sucedido. */
export async function finalizeConnected(
  tenantId: string,
  conn: WhatsappConnection,
  phoneHint?: string | null,
): Promise<void> {
  const realUrl = webhookUrlFor(conn.webhook_token);
  try {
    await zapiClient.configureEveryWebhook(credsOf(conn), realUrl, true);
    await markWebhookConfigured(tenantId, conn.id, true);
  } catch (err) {
    logger.warn(`Webhook pós-conexão falhou (${conn.id})`, err);
  }

  let phone = phoneHint?.replace(/\D/g, '') || null;
  if (!phone) {
    try {
      phone = await fetchDevicePhone({
        instanceId: conn.secrets.instanceId!,
        token: conn.secrets.token!,
        clientToken: conn.secrets.clientToken,
        baseUrl: conn.base_url || env.ZAPI_BASE_URL,
      });
    } catch {
      /* ignore */
    }
  }
  if (phone && phone.length >= 10) {
    await updateConnectionPhoneNumber(conn.id, phone);
  }

  await pushStatus(tenantId, conn.id, 'CONECTADO', {
    detail: phone ? `Conectado · ${phone}` : 'WhatsApp conectado',
    phone,
  });
  invalidateTenantWhatsapp(tenantId);
}

export async function handleConnectionWebhookEvent(
  tenantId: string,
  connection: WhatsappConnection,
  body: Record<string, unknown>,
): Promise<boolean> {
  const type = String(body.type ?? body.event ?? '').toLowerCase();
  // Evita tratar mensagem comum como evento de conexão.
  const looksLikeMessage =
    'text' in body ||
    'image' in body ||
    'audio' in body ||
    'video' in body ||
    'document' in body ||
    'messageId' in body ||
    'reaction' in body;
  if (looksLikeMessage && !type.includes('callback')) return false;

  const connectedFlag =
    type.includes('connectedcallback') ||
    (type === 'connected' && body.connected !== false);

  const disconnectedFlag =
    type.includes('disconnectedcallback') ||
    type.includes('disconnectcallback') ||
    type === 'disconnected';

  if (connectedFlag && !disconnectedFlag) {
    const phone =
      body.phone != null
        ? String(body.phone).replace(/\D/g, '')
        : null;
    await finalizeConnected(tenantId, connection, phone);
    return true;
  }

  if (disconnectedFlag) {
    await pushStatus(tenantId, connection.id, 'DESCONECTADO', {
      detail: 'WhatsApp desconectou. Escaneie um novo QR para reconectar.',
    });
    return true;
  }

  return false;
}

export async function disconnectWhatsapp(tenantId: string, connectionId: string): Promise<void> {
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) throw new AppError('Conexão não encontrada.', 404, 'NOT_FOUND');

  // Desloga o número na Z-API antes de limpar/reciclar (senão o próximo trial herda sessão).
  if (conn.secrets.instanceId && conn.secrets.token) {
    try {
      await zapiClient.disconnectInstance(credsOf(conn));
    } catch (err) {
      logger.warn(`Z-API disconnect falhou (${conn.id}) — seguindo com limpeza local`, err);
    }
  }

  if (conn.instance_origin === 'pool' && conn.pool_instance_id) {
    await releasePoolInstance(conn.pool_instance_id);
  }

  await clearConnectionSecrets(tenantId, connectionId);
  await pushStatus(tenantId, connectionId, 'DESCONECTADO', {
    detail: 'Desconectado',
  });
  invalidateTenantWhatsapp(tenantId);
}

/** Assina instância on-demand quando a conta vira pagante. */
export async function subscribeConnectionOnPayment(
  tenantId: string,
  connectionId: string,
): Promise<void> {
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) throw new AppError('Conexão não encontrada.', 404, 'NOT_FOUND');
  if (conn.zapi_subscribed) return;
  if (conn.instance_origin !== 'on_demand') {
    // Pool já é pago; só marca conta.
    await markZapiSubscribed(tenantId, connectionId, true);
    return;
  }
  await zapiClient.subscribeInstance(credsOf(conn), false);
  await markZapiSubscribed(tenantId, connectionId, true);
}

export async function activateTenantPaid(tenantId: string): Promise<void> {
  await updateTenant(tenantId, {
    account_status: 'active',
    trial_ends_at: null,
  });
  // Assina todas as conexões on-demand ainda não assinadas.
  const conns = await listConnections(tenantId);
  for (const c of conns) {
    if (c.instance_origin === 'on_demand' && !c.zapi_subscribed && c.secrets.instanceId) {
      try {
        await subscribeConnectionOnPayment(tenantId, c.id);
      } catch (err) {
        logger.warn(`Falha ao assinar conexão ${c.id} no pagamento`, err);
      }
    }
  }
}

/** Tick: expira QR e recicla pool de trials vencidos. */
export async function tickWhatsappOnboarding(): Promise<void> {
  const expiredQr = await listExpiredOnboardings();
  for (const conn of expiredQr) {
    await pushStatus(conn.tenant_id, conn.id, 'EXPIRADO', {
      detail: 'QR/pareamento expirou. Toque em gerar novo QR.',
    }).catch(() => undefined);
  }

  const expiredTenants = await listExpiredTrialTenants();
  for (const tenant of expiredTenants) {
    const poolConns = await listPoolConnectionsForTenant(tenant.id);
    for (const conn of poolConns) {
      try {
        // Reusa o fluxo completo: disconnect Z-API + release pool + limpa secrets.
        await disconnectWhatsapp(tenant.id, conn.id);
        await pushStatus(tenant.id, conn.id, 'DESCONECTADO', {
          detail: 'Período de teste encerrado — número desconectado.',
        });
      } catch (err) {
        logger.warn(`Falha ao reciclar pool do trial ${tenant.id}`, err);
      }
    }
    await setTenantAccountStatus(tenant.id, 'expired');
  }
}
