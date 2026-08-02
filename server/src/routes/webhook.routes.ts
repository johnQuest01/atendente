import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { handleWhatsappWebhook, verifyWhatsappWebhook } from '../controllers/webhook.controller';

const router = Router();

// Verificação do webhook da Meta Cloud: ao cadastrar a URL, a Meta faz um GET
// com hub.challenge e só ativa a assinatura se devolvermos o desafio.
router.get('/whatsapp/:webhookToken', asyncHandler(verifyWhatsappWebhook));

// Rota POR EMPRESA: cada instância (Z-API/Evolution/Meta) posta em
// /webhook/whatsapp/<token>. O token opaco resolve o tenant + provedor.
router.post('/whatsapp/:webhookToken', asyncHandler(handleWhatsappWebhook));

// Rota LEGADA (sem token): mapeada para o tenant padrão. Mantida para não
// quebrar a integração atual até a URL ser atualizada na Z-API.
router.post('/whatsapp', asyncHandler(handleWhatsappWebhook));

export default router;
