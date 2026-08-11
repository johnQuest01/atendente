import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import {
  bindPoolToConnection,
  claimFreePoolInstance,
  type PoolProviderMode,
} from '../../db/queries/instance_pool';
import { getTenantById, type TenantRow } from '../../db/queries/tenants';
import { zapiClient } from './ZApiClient';

export type InstanceOrigin = 'on_demand' | 'pool';

export interface ProvisionedInstance {
  instanceId: string;
  token: string;
  clientToken?: string;
  origin: InstanceOrigin;
  poolInstanceId?: string;
  /** true se já está assinada (pool pago). on-demand nasce sem assinatura. */
  subscribed: boolean;
}

export interface ProvisionContext {
  tenantId: string;
  tenantName: string;
  label: string;
  providerMode: PoolProviderMode;
  /** URL pública do webhook desta conexão (mensagens + status). */
  webhookUrl: string;
}

export interface InstanceProvisioner {
  readonly mode: InstanceOrigin;
  provision(ctx: ProvisionContext): Promise<ProvisionedInstance>;
}

/**
 * Conta em trial (7 dias) → pool pago. Conta active → on-demand.
 * Se on-demand exige Partner-Token e ele não está configurado, cai no pool
 * (evita travar o onboarding enquanto o token de parceiro não chega).
 */
export function resolveProvisionMode(tenant: TenantRow): InstanceOrigin {
  if (env.ZAPI_PROVISION_MODE === 'pool') return 'pool';
  if (env.ZAPI_PROVISION_MODE === 'on-demand') {
    return env.hasZapiPartner ? 'on_demand' : 'pool';
  }
  // auto
  if (tenant.account_status === 'active' && env.hasZapiPartner) return 'on_demand';
  return 'pool';
}

export class OnDemandProvisioner implements InstanceProvisioner {
  readonly mode = 'on_demand' as const;

  async provision(ctx: ProvisionContext): Promise<ProvisionedInstance> {
    if (!env.hasZapiPartner) {
      throw new AppError(
        'Falta ZAPI_PARTNER_TOKEN no servidor. Enquanto isso: Empresar → Pool WhatsApp (adicionar instância assinada) ou use credenciais manuais.',
        503,
        'ZAPI_PARTNER_MISSING',
      );
    }
    const created = await zapiClient.createInstanceOnDemand({
      name: `tenant-${ctx.tenantId.slice(0, 8)}-${ctx.label}`.slice(0, 80),
      sessionName: ctx.label.slice(0, 40),
      isDevice: ctx.providerMode === 'phoneless',
      receivedAndDeliveryCallbackUrl: ctx.webhookUrl,
      connectedCallbackUrl: ctx.webhookUrl,
      disconnectedCallbackUrl: ctx.webhookUrl,
    });
    return {
      instanceId: created.instanceId,
      token: created.token,
      clientToken: env.ZAPI_CLIENT_TOKEN,
      origin: 'on_demand',
      subscribed: false,
    };
  }
}

export class PoolProvisioner implements InstanceProvisioner {
  readonly mode = 'pool' as const;

  async provision(ctx: ProvisionContext): Promise<ProvisionedInstance> {
    const claimed = await claimFreePoolInstance(ctx.tenantId, ctx.providerMode);
    if (!claimed) {
      throw new AppError(
        env.hasZapiPartner
          ? 'Não há instância livre no pool. Tente de novo ou fale com o suporte.'
          : 'Pool vazio e sem ZAPI_PARTNER_TOKEN. Em Empresas → Pool WhatsApp, adicione uma instância já assinada da Z-API, ou use Credenciais manuais nesta tela.',
        503,
        'POOL_EMPTY',
      );
    }
    return {
      instanceId: claimed.secrets.instanceId,
      token: claimed.secrets.token,
      clientToken: claimed.secrets.clientToken ?? env.ZAPI_CLIENT_TOKEN,
      origin: 'pool',
      poolInstanceId: claimed.row.id,
      subscribed: true,
    };
  }
}

export async function getProvisionerForTenant(tenantId: string): Promise<{
  provisioner: InstanceProvisioner;
  tenant: TenantRow;
  origin: InstanceOrigin;
}> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new AppError('Empresa não encontrada.', 404, 'TENANT_NOT_FOUND');
  const origin = resolveProvisionMode(tenant);
  const provisioner = origin === 'pool' ? new PoolProvisioner() : new OnDemandProvisioner();
  return { provisioner, tenant, origin };
}

export { bindPoolToConnection };
