import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import {
  createScriptSchema,
  getScripts,
  idParamSchema,
  patchScript,
  postScript,
  removeScript,
  updateScriptSchema,
} from '../controllers/messages.controller';

const router = Router();

router.use(authenticate);

router.get('/', asyncHandler(getScripts));
router.post('/', validate({ body: createScriptSchema }), asyncHandler(postScript));
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateScriptSchema }),
  asyncHandler(patchScript),
);
router.delete('/:id', validate({ params: idParamSchema }), asyncHandler(removeScript));

export default router;
