import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import { uploadAudio } from '../middleware/upload.middleware';
import {
  getAudio,
  getAudios,
  idParamSchema,
  patchAudio,
  removeAudio,
  updateAudioSchema,
  uploadAudioHandler,
} from '../controllers/audios.controller';

const router = Router();

router.use(authenticate);

router.get('/', asyncHandler(getAudios));
router.get('/:id', validate({ params: idParamSchema }), asyncHandler(getAudio));
router.post('/', uploadAudio.single('file'), asyncHandler(uploadAudioHandler));
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateAudioSchema }),
  asyncHandler(patchAudio),
);
router.delete('/:id', validate({ params: idParamSchema }), asyncHandler(removeAudio));

export default router;
