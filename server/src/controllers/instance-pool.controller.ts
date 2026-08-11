import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  addPoolInstance,
  countFreePool,
  listPoolInstances,
} from '../db/queries/instance_pool';
import { hasEncryptionKey } from '../utils/crypto';
import { AppError } from '../utils/errors';

/**
 * Ops do pool de instâncias Z-API (trial de 7 dias do cliente).
 * Só superadmin — as instâncias precisam estar pré-assinadas na Z-API.
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
