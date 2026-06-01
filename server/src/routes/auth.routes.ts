import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate, authorize } from '../middleware/auth.middleware';
import {
  login,
  loginSchema,
  me,
  register,
  registerSchema,
} from '../controllers/auth.controller';

const router = Router();

router.post('/login', validate({ body: loginSchema }), asyncHandler(login));
router.get('/me', authenticate, asyncHandler(me));
router.post(
  '/register',
  authenticate,
  authorize('admin'),
  validate({ body: registerSchema }),
  asyncHandler(register),
);

export default router;
