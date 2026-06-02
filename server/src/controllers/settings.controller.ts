import type { Request, Response } from 'express';
import { z } from 'zod';
import { isAgentEnabled, setAgentEnabled, getAiPersona, setAiPersona } from '../db/queries/settings';
import { DEFAULT_AI_PERSONA } from '../config/persona';
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

export const updatePersonaSchema = z.object({
  // Vazio é permitido: limpa a personalização e volta ao padrão.
  prompt: z.string().max(12000, 'O texto está muito longo (máx. 12000 caracteres).'),
});

export async function getPersona(_req: Request, res: Response): Promise<void> {
  const prompt = await getAiPersona();
  res.json({ prompt, default: DEFAULT_AI_PERSONA, isDefault: prompt === DEFAULT_AI_PERSONA });
}

export async function putPersona(req: Request, res: Response): Promise<void> {
  const { prompt } = req.body as z.infer<typeof updatePersonaSchema>;
  const effective = await setAiPersona(prompt);
  res.json({ prompt: effective, default: DEFAULT_AI_PERSONA, isDefault: effective === DEFAULT_AI_PERSONA });
}
