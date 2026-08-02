import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { requireActiveTenant } from '../middleware/tenantAccess.middleware';
import { authenticate } from '../middleware/auth.middleware';
import { getDashboard } from '../controllers/dashboard.controller';

const router = Router();

router.use(authenticate, requireActiveTenant);
router.get('/', asyncHandler(getDashboard));

export default router;
