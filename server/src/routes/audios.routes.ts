import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { requireActiveTenant } from '../middleware/tenantAccess.middleware';
import { authenticate } from '../middleware/auth.middleware';
import { uploadAudio } from '../middleware/upload.middleware';
import {
  getAudio,
  getAudios,
  idParamSchema,
  patchAudio,
  removeAudio,
  replaceAudioFileHandler,
  updateAudioSchema,
  uploadAudioHandler,
} from '../controllers/audios.controller';

const router = Router();

router.use(authenticate, requireActiveTenant);

router.get('/', asyncHandler(getAudios));
router.get('/:id', validate({ params: idParamSchema }), asyncHandler(getAudio));
router.post('/', uploadAudio.single('file'), asyncHandler(uploadAudioHandler));
router.post(
  '/:id/file',
  validate({ params: idParamSchema }),
  uploadAudio.single('file'),
  asyncHandler(replaceAudioFileHandler),
);
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateAudioSchema }),
  asyncHandler(patchAudio),
);
router.delete('/:id', validate({ params: idParamSchema }), asyncHandler(removeAudio));

export default router;
