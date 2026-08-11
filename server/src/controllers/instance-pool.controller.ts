import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import {
  addPoolInstance,
  countFreePool,
  listPoolInstances,
  poolHasInstanceId,
} from '../db/queries/instance_pool';
import { hasEncryptionKey } from '../utils/crypto';
import { AppError } from '../utils/errors';

/**
 * Ops do pool: instâncias Z-API já pagas, SEM número pareado.
 * O cliente só digita o telefone no app — nunca vê a Z-API.
 */

export const addPoolBodySchema = z.object({
  instanceId: z.string().trim().min(3).max(120),
  token: z.string().trim().min(3).max(200),
  clientToken: z.string().trim().min(3).max(200).optional(),
  providerMode: z.enum(['web', 'phoneless']).optional().default('web'),
  label: z.string().trim().min(1).max(120).optional(),
});

export async function getInstancePool(_req: Request, res: Response): Promise<void> {
  const instances = await listPoolInstances();
  const freeWeb = await countFreePool('web');
  const freePhoneless = await countFreePool('phoneless');
  res.json({
    instances,
    free: { web: freeWeb, phoneless: freePhoneless },
    encryptionAvailable: hasEncryptionKey(),
    envInstanceConfigured: Boolean(env.ZAPI_INSTANCE_ID && env.ZAPI_TOKEN),
  });
}

export async function postInstancePool(req: Request, res: Response): Promise<void> {
  if (!hasEncryptionKey()) {
    throw new AppError(
      'Defina ENCRYPTION_KEY no servidor para guardar o pool com segurança.',
      503,
      'ENCRYPTION_MISSING',
    );
  }
  const body = req.body as z.infer<typeof addPoolBodySchema>;
  if (await poolHasInstanceId(body.instanceId)) {
    throw new AppError('Esta instância já está no pool.', 409, 'POOL_DUPLICATE');
  }
  const row = await addPoolInstance({
    secrets: {
      instanceId: body.instanceId,
      token: body.token,
      clientToken: body.clientToken,
    },
    providerMode: body.providerMode,
    label: body.label ?? null,
  });
  res.status(201).json({
    id: row.id,
    providerMode: row.provider_mode,
    state: row.state,
    label: row.label,
  });
}

/**
 * Atalho provisório: coloca no pool a instância dos secrets ZAPI_INSTANCE_ID/TOKEN
 * (só se ainda não estiver no pool). Use APENAS se ela estiver paga e SEM número.
 */
export async function postImportEnvToPool(_req: Request, res: Response): Promise<void> {
  if (!hasEncryptionKey()) {
    throw new AppError(
      'Defina ENCRYPTION_KEY no servidor para guardar o pool com segurança.',
      503,
      'ENCRYPTION_MISSING',
    );
  }
  const instanceId = env.ZAPI_INSTANCE_ID?.trim();
  const token = env.ZAPI_TOKEN?.trim();
  if (!instanceId || !token) {
    throw new AppError(
      'Não há ZAPI_INSTANCE_ID/ZAPI_TOKEN nos secrets do servidor.',
      400,
      'ENV_INSTANCE_MISSING',
    );
  }
  if (await poolHasInstanceId(instanceId)) {
    throw new AppError('A instância do env já está no pool.', 409, 'POOL_DUPLICATE');
  }
  const row = await addPoolInstance({
    secrets: {
      instanceId,
      token,
      clientToken: env.ZAPI_CLIENT_TOKEN,
    },
    providerMode: 'web',
    label: 'Instância plataforma (env)',
  });
  res.status(201).json({
    id: row.id,
    providerMode: row.provider_mode,
    state: row.state,
    label: row.label,
  });
}
