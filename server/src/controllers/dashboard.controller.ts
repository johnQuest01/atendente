import type { Request, Response } from 'express';
import {
  getActivityByHour,
  getDashboardMetrics,
  getTopAudios,
} from '../db/queries/metrics';

export async function getDashboard(_req: Request, res: Response): Promise<void> {
  const [metrics, topAudios, activity] = await Promise.all([
    getDashboardMetrics(),
    getTopAudios(5),
    getActivityByHour(),
  ]);
  res.json({ metrics, topAudios, activity });
}
