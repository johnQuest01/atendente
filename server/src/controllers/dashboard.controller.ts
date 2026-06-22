import type { Request, Response } from 'express';
import {
  getActivityByHour,
  getDashboardMetrics,
  getTopAudios,
} from '../db/queries/metrics';

export async function getDashboard(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const [metrics, topAudios, activity] = await Promise.all([
    getDashboardMetrics(tenantId),
    getTopAudios(tenantId, 5),
    getActivityByHour(tenantId),
  ]);
  res.json({ metrics, topAudios, activity });
}
