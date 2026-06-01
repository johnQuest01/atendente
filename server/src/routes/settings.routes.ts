import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import {
  getAgentStatus,
  putAgentStatus,
  updateAgentSchema,
} from '../controllers/settings.controller';

const router = Router();

router.use(authenticate);

router.get('/agent', asyncHandler(getAgentStatus));
router.put('/agent', validate({ body: updateAgentSchema }), asyncHandler(putAgentStatus));

export default router;
