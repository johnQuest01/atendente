import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { getAudioMedia, getFileMedia } from '../controllers/media.controller';

const router = Router();

// Mídia pública servida a partir do banco (necessário para a Z-API baixar).
router.get('/audios/:id', asyncHandler(getAudioMedia));
router.get('/files/:id', asyncHandler(getFileMedia));

export default router;
