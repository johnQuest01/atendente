import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import {
  createBlockedSchema,
  getBlocked,
  idParamSchema,
  patchBlocked,
  postBlocked,
  removeBlocked,
  updateBlockedSchema,
} from '../controllers/blocked.controller';

const router = Router();

router.use(authenticate);

router.get('/', asyncHandler(getBlocked));
router.post('/', validate({ body: createBlockedSchema }), asyncHandler(postBlocked));
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateBlockedSchema }),
  asyncHandler(patchBlocked),
);
router.delete('/:id', validate({ params: idParamSchema }), asyncHandler(removeBlocked));

export default router;
