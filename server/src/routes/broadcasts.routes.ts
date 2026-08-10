import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { requireActiveTenant } from '../middleware/tenantAccess.middleware';
import { authenticate, authorize } from '../middleware/auth.middleware';
import {
  broadcastIdSchema,
  cancelBroadcast,
  createBroadcastSchema,
  getBroadcastDetail,
  getBroadcasts,
  postBroadcast,
  startBroadcast,
} from '../controllers/broadcasts.controller';

const router = Router();
router.use(authenticate, requireActiveTenant);

const adminOnly = authorize('admin', 'superadmin');

router.get('/', asyncHandler(getBroadcasts));
router.get('/:id', validate({ params: broadcastIdSchema }), asyncHandler(getBroadcastDetail));
router.post('/', adminOnly, validate({ body: createBroadcastSchema }), asyncHandler(postBroadcast));
router.post(
  '/:id/start',
  adminOnly,
  validate({ params: broadcastIdSchema }),
  asyncHandler(startBroadcast),
);
router.post(
  '/:id/cancel',
  adminOnly,
  validate({ params: broadcastIdSchema }),
  asyncHandler(cancelBroadcast),
);

export default router;
