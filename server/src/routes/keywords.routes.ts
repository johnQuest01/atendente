import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import {
  createKeywordSchema,
  getKeywords,
  idParamSchema,
  patchKeyword,
  postKeyword,
  removeKeyword,
  updateKeywordSchema,
} from '../controllers/keywords.controller';

const router = Router();

router.use(authenticate);

router.get('/', asyncHandler(getKeywords));
router.post('/', validate({ body: createKeywordSchema }), asyncHandler(postKeyword));
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateKeywordSchema }),
  asyncHandler(patchKeyword),
);
router.delete('/:id', validate({ params: idParamSchema }), asyncHandler(removeKeyword));

export default router;
