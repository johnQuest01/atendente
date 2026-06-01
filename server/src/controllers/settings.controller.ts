import type { Request, Response } from 'express';
import { z } from 'zod';
import { isAgentEnabled, setAgentEnabled } from '../db/queries/settings';
import { emitAgentStatus } from '../socket';

export const updateAgentSchema = z.object({
  enabled: z.boolean(),
});

export async function getAgentStatus(_req: Request, res: Response): Promise<void> {
  const enabled = await isAgentEnabled();
  res.json({ enabled });
}

export async function putAgentStatus(req: Request, res: Response): Promise<void> {
  const { enabled } = req.body as z.infer<typeof updateAgentSchema>;
  await setAgentEnabled(enabled);
  emitAgentStatus(enabled);
  res.json({ enabled });
}
