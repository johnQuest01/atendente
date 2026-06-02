import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import {
  getAgentStatus,
  putAgentStatus,
  updateAgentSchema,
  getPersona,
  putPersona,
  updatePersonaSchema,
} from '../controllers/settings.controller';

const router = Router();

router.use(authenticate);

router.get('/agent', asyncHandler(getAgentStatus));
router.put('/agent', validate({ body: updateAgentSchema }), asyncHandler(putAgentStatus));

router.get('/persona', asyncHandler(getPersona));
router.put('/persona', validate({ body: updatePersonaSchema }), asyncHandler(putPersona));

export default router;
