import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { handleWhatsappWebhook } from '../controllers/webhook.controller';

const router = Router();

// A Z-API faz POST aqui a cada mensagem recebida / atualização de status.
router.post('/whatsapp', asyncHandler(handleWhatsappWebhook));

export default router;
