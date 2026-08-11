import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/errors';

/**
 * Cliente único das chamadas Z-API usadas no onboarding embutido.
 *
 * Paths confirmados na doc (developer.z-api.io):
 * - Criar: POST /instances/integrator/on-demand (Partner-Token)
 * - Assinar: POST /instances/{id}/token/{token}/integrator/on-demand/subscription
 * - QR imagem: GET /instances/{id}/token/{token}/qr-code/image
 * - Código telefone: GET /instances/{id}/token/{token}/phone-code/{phone}
 * - Status: GET /instances/{id}/token/{token}/status
 * - Disconnect: POST /instances/{id}/token/{token}/disconnect
 * - Webhooks: PUT /instances/{id}/token/{token}/update-every-webhooks
 *
 * Partner Token: liberado no programa de integrador da Z-API (após ~10
 * instâncias). Até lá usamos pool de instâncias já assinadas.
 * `isDevice: true` = phoneless/mobile — ainda exige código/QR no aparelho.
 *
 * Nunca logar tokens.
 */

export interface ZApiInstanceCreds {
  instanceId: string;
  token: string;
}

export interface CreateInstanceInput {
  name: string;
  /** true = mobile/phoneless; false = web (padrão). */
  isDevice?: boolean;
  sessionName?: string;
  connectedCallbackUrl?: string;
  disconnectedCallbackUrl?: string;
  receivedCallbackUrl?: string;
  receivedAndDeliveryCallbackUrl?: string;
}

export interface QrImageResult {
  /** data URL ou base64 puro da imagem, se disponível. */
  imageBase64: string | null;
  /** Challenge de passkey (WhatsApp) — front só avisa; completar é edge case. */
  challenge: unknown | null;
  raw: unknown;
}

export interface PhoneCodeResult {
  code: string | null;
  challenge: unknown | null;
  raw: unknown;
}

export interface InstanceStatusResult {
  connected: boolean;
  smartphoneConnected: boolean;
  detail: string;
  raw: unknown;
}

function partnerHeaders(): Record<string, string> {
  const token = env.ZAPI_PARTNER_TOKEN;
  if (!token) {
    throw new AppError(
      'Onboarding WhatsApp indisponível: ZAPI_PARTNER_TOKEN não configurado.',
      503,
      'ZAPI_PARTNER_MISSING',
    );
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function instanceHeaders(includeClientToken = true): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (includeClientToken && env.ZAPI_CLIENT_TOKEN) {
    h['Client-Token'] = env.ZAPI_CLIENT_TOKEN;
  }
  return h;
}

function instanceBase(creds: ZApiInstanceCreds): string {
  const root = env.ZAPI_BASE_URL.replace(/\/+$/, '');
  return `${root}/${creds.instanceId}/token/${creds.token}`;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

export class ZApiClient {
  /** Cria instância on-demand (trial Z-API de 2 dias até assinar). */
  async createInstanceOnDemand(input: CreateInstanceInput): Promise<ZApiInstanceCreds & { due?: number }> {
    const url = 'https://api.z-api.io/instances/integrator/on-demand';
    const body: Record<string, unknown> = {
      name: input.name,
      isDevice: input.isDevice ?? false,
    };
    if (input.sessionName) body.sessionName = input.sessionName;
    if (input.connectedCallbackUrl) body.connectedCallbackUrl = input.connectedCallbackUrl;
    if (input.disconnectedCallbackUrl) body.disconnectedCallbackUrl = input.disconnectedCallbackUrl;
    if (input.receivedCallbackUrl) body.receivedCallbackUrl = input.receivedCallbackUrl;
    if (input.receivedAndDeliveryCallbackUrl) {
      body.receivedAndDeliveryCallbackUrl = input.receivedAndDeliveryCallbackUrl;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: partnerHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = asRecord(await readBody(res));
    if (!res.ok) {
      logger.error(`Z-API create on-demand HTTP ${res.status}`);
      throw new AppError(
        `Falha ao criar instância WhatsApp (HTTP ${res.status}).`,
        502,
        'ZAPI_CREATE_FAILED',
      );
    }
    const instanceId = String(data.id ?? '');
    const token = String(data.token ?? '');
    if (!instanceId || !token) {
      throw new AppError('Z-API não devolveu id/token da instância.', 502, 'ZAPI_CREATE_INVALID');
    }
    return {
      instanceId,
      token,
      due: typeof data.due === 'number' ? data.due : undefined,
    };
  }

  /** Assina instância (após conversão/pagamento). */
  async subscribeInstance(creds: ZApiInstanceCreds, withCalls = false): Promise<void> {
    const url = `${instanceBase(creds)}/integrator/on-demand/subscription`;
    const res = await fetch(url, {
      method: 'POST',
      headers: partnerHeaders(),
      body: JSON.stringify({ withCalls }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 201) {
      logger.error(`Z-API subscribe HTTP ${res.status}`);
      throw new AppError(
        `Falha ao assinar instância WhatsApp (HTTP ${res.status}).`,
        502,
        'ZAPI_SUBSCRIBE_FAILED',
      );
    }
  }

  /** QR em imagem base64 (doc: qr-code/image). */
  async getQrCodeImage(creds: ZApiInstanceCreds): Promise<QrImageResult> {
    const url = `${instanceBase(creds)}/qr-code/image`;
    const res = await fetch(url, {
      method: 'GET',
      headers: instanceHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await readBody(res);
    if (!res.ok) {
      logger.error(`Z-API qr-code/image HTTP ${res.status}`);
      throw new AppError('Não foi possível obter o QR Code agora.', 502, 'ZAPI_QR_FAILED');
    }
    const rec = asRecord(data);
    if (rec.challenge) {
      return { imageBase64: null, challenge: rec.challenge, raw: data };
    }
    // Resposta pode ser string base64, { value: "data:image..." } ou bytes JSON.
    let imageBase64: string | null = null;
    if (typeof data === 'string' && data.length > 40) {
      imageBase64 = data.startsWith('data:') ? data : `data:image/png;base64,${data}`;
    } else if (typeof rec.value === 'string') {
      imageBase64 = rec.value.startsWith('data:')
        ? rec.value
        : `data:image/png;base64,${rec.value}`;
    } else if (typeof rec.qrcode === 'string') {
      imageBase64 = rec.qrcode.startsWith('data:')
        ? rec.qrcode
        : `data:image/png;base64,${rec.qrcode}`;
    }
    return { imageBase64, challenge: null, raw: data };
  }

  /** Código de pareamento por número (doc: phone-code/{phone}). */
  async getPhoneCode(creds: ZApiInstanceCreds, phoneDigits: string): Promise<PhoneCodeResult> {
    const phone = phoneDigits.replace(/\D/g, '');
    const url = `${instanceBase(creds)}/phone-code/${phone}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: instanceHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await readBody(res);
    if (!res.ok) {
      logger.error(`Z-API phone-code HTTP ${res.status}`);
      throw new AppError('Não foi possível gerar o código de pareamento.', 502, 'ZAPI_PHONE_CODE_FAILED');
    }
    const rec = asRecord(data);
    if (rec.challenge) {
      return { code: null, challenge: rec.challenge, raw: data };
    }
    const code = typeof rec.value === 'string' ? rec.value : null;
    return { code, challenge: null, raw: data };
  }

  async getStatus(creds: ZApiInstanceCreds): Promise<InstanceStatusResult> {
    const url = `${instanceBase(creds)}/status`;
    const res = await fetch(url, {
      method: 'GET',
      headers: instanceHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await readBody(res);
    if (!res.ok) {
      return {
        connected: false,
        smartphoneConnected: false,
        detail: `HTTP ${res.status}`,
        raw: data,
      };
    }
    const rec = asRecord(data);
    const connected = Boolean(rec.connected);
    const smartphoneConnected = rec.smartphoneConnected !== false;
    return {
      connected,
      smartphoneConnected,
      detail: connected && smartphoneConnected ? 'Conectado' : 'Aguardando pareamento',
      raw: data,
    };
  }

  /** Desconecta o número da instância (POST /disconnect) — necessário ao reciclar pool. */
  async disconnectInstance(creds: ZApiInstanceCreds): Promise<void> {
    const url = `${instanceBase(creds)}/disconnect`;
    const res = await fetch(url, {
      method: 'POST',
      headers: instanceHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn(`Z-API disconnect HTTP ${res.status}`);
      throw new AppError(
        `Falha ao desconectar instância WhatsApp (HTTP ${res.status}).`,
        502,
        'ZAPI_DISCONNECT_FAILED',
      );
    }
  }

  async configureEveryWebhook(
    creds: ZApiInstanceCreds,
    webhookUrl: string,
    notifySentByMe = true,
  ): Promise<void> {
    if (!webhookUrl.startsWith('https://')) {
      throw new AppError('Webhook precisa ser HTTPS.', 400, 'WEBHOOK_HTTPS');
    }
    const url = `${instanceBase(creds)}/update-every-webhooks`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: instanceHeaders(),
      body: JSON.stringify({ value: webhookUrl, notifySentByMe }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.error(`Z-API update-every-webhooks HTTP ${res.status}`);
      throw new AppError('Falha ao configurar webhook na Z-API.', 502, 'ZAPI_WEBHOOK_FAILED');
    }
  }
}

export const zapiClient = new ZApiClient();
