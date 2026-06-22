import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate, requireBlockAccess } from '../middleware/auth.middleware';
import { authLimiter } from '../middleware/rateLimit.middleware';
import {
  createBlockedSchema,
  getBlocked,
  idParamSchema,
  patchBlocked,
  postBlocked,
  removeBlocked,
  unlockBlocked,
  unlockSchema,
  updateBlockedSchema,
} from '../controllers/blocked.controller';

const router = Router();

router.use(authenticate);

// Login do cadeado: exige o usuário autenticado + rate limit anti força-bruta.
router.post('/unlock', authLimiter, validate({ body: unlockSchema }), asyncHandler(unlockBlocked));

// Daqui pra baixo, tudo exige o token do cadeado (área restrita).
router.use(requireBlockAccess);

router.get('/', asyncHandler(getBlocked));
router.post('/', validate({ body: createBlockedSchema }), asyncHandler(postBlocked));
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateBlockedSchema }),
  asyncHandler(patchBlocked),
);
router.delete('/:id', validate({ params: idParamSchema }), asyncHandler(removeBlocked));

export default router;
