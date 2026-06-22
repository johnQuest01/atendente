import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/auth.middleware';
import {
  getAgentStatus,
  putAgentStatus,
  updateAgentSchema,
  getPersona,
  putPersona,
  updatePersonaSchema,
  getSystemStatus,
  getWhatsappConnection,
  putWhatsappConnection,
  updateWhatsappSchema,
} from '../controllers/settings.controller';

const router = Router();

router.use(authenticate);

router.get('/agent', asyncHandler(getAgentStatus));
router.put('/agent', validate({ body: updateAgentSchema }), asyncHandler(putAgentStatus));

router.get('/persona', asyncHandler(getPersona));
router.put('/persona', validate({ body: updatePersonaSchema }), asyncHandler(putPersona));

// Status REAL das integrações (banco, Claude, WhatsApp, STT).
router.get('/status', asyncHandler(getSystemStatus));

// Conexão de WhatsApp da empresa (cadastro de credenciais). Só admin edita.
router.get('/whatsapp', asyncHandler(getWhatsappConnection));
router.put(
  '/whatsapp',
  authorize('admin', 'superadmin'),
  validate({ body: updateWhatsappSchema }),
  asyncHandler(putWhatsappConnection),
);

export default router;
