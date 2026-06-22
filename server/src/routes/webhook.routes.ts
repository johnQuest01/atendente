import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { handleWhatsappWebhook } from '../controllers/webhook.controller';

const router = Router();

// Rota POR EMPRESA: cada instância (Z-API/Evolution) posta em
// /webhook/whatsapp/<token>. O token opaco resolve o tenant + provedor.
router.post('/whatsapp/:webhookToken', asyncHandler(handleWhatsappWebhook));

// Rota LEGADA (sem token): mapeada para o tenant padrão. Mantida para não
// quebrar a integração atual até a URL ser atualizada na Z-API.
router.post('/whatsapp', asyncHandler(handleWhatsappWebhook));

export default router;
