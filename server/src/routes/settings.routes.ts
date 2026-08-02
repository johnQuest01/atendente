import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { requireActiveTenant } from '../middleware/tenantAccess.middleware';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/auth.middleware';
import {
  getAgentStatus,
  putAgentStatus,
  updateAgentSchema,
  getPersona,
  putPersona,
  updatePersonaSchema,
  previewPersona,
  previewPersonaSchema,
  getSystemStatus,
  getWhatsappConnection,
  putWhatsappConnection,
  updateWhatsappSchema,
} from '../controllers/settings.controller';
import {
  tenantAiProviders,
  createAiProviderSchema,
  updateAiProviderSchema,
  aiProviderIdParamSchema,
  testAiCredsSchema,
  listAiModelsSchema,
} from '../controllers/ai_providers.controller';
import {
  getReminderOwners,
  postReminderOwner,
  createReminderOwnerSchema,
  deleteReminderOwner,
  reminderOwnerParamSchema,
  getReminders,
  listRemindersQuerySchema,
} from '../controllers/reminders.controller';

const router = Router();

router.use(authenticate, requireActiveTenant);

const adminOnly = authorize('admin', 'superadmin');

router.get('/agent', asyncHandler(getAgentStatus));
router.put('/agent', validate({ body: updateAgentSchema }), asyncHandler(putAgentStatus));

router.get('/persona', asyncHandler(getPersona));
router.put('/persona', validate({ body: updatePersonaSchema }), asyncHandler(putPersona));
// Playground: testa o prompt gerando uma resposta de exemplo (sem enviar WhatsApp).
router.post('/persona/preview', validate({ body: previewPersonaSchema }), asyncHandler(previewPersona));

// Status REAL das integrações (banco, Claude, WhatsApp, STT).
router.get('/status', asyncHandler(getSystemStatus));

// Conexão de WhatsApp da empresa (cadastro de credenciais). Só admin edita.
router.get('/whatsapp', asyncHandler(getWhatsappConnection));
router.put(
  '/whatsapp',
  adminOnly,
  validate({ body: updateWhatsappSchema }),
  asyncHandler(putWhatsappConnection),
);

// Assistente pessoal de lembretes: quais números da empresa falam com ele em
// vez de serem atendidos como clientes. Só admin mexe na whitelist.
router.get('/reminder-owners', adminOnly, asyncHandler(getReminderOwners));
router.post(
  '/reminder-owners',
  adminOnly,
  validate({ body: createReminderOwnerSchema }),
  asyncHandler(postReminderOwner),
);
router.delete(
  '/reminder-owners/:phone',
  adminOnly,
  validate({ params: reminderOwnerParamSchema }),
  asyncHandler(deleteReminderOwner),
);
router.get(
  '/reminders',
  adminOnly,
  validate({ query: listRemindersQuerySchema }),
  asyncHandler(getReminders),
);

// IA da EMPRESA (BYO): conectar/ordenar as próprias chaves. Só admin gerencia.
// Quando a empresa tem provedores próprios, eles têm prioridade sobre o padrão
// da plataforma e o uso NÃO conta no teto mensal.
router.get('/ai/usage', asyncHandler(tenantAiProviders.getAiUsageInfo));
router.get('/ai/providers', adminOnly, asyncHandler(tenantAiProviders.getAiProviders));
router.post(
  '/ai/providers',
  adminOnly,
  validate({ body: createAiProviderSchema }),
  asyncHandler(tenantAiProviders.postAiProvider),
);
router.post(
  '/ai/providers/test',
  adminOnly,
  validate({ body: testAiCredsSchema }),
  asyncHandler(tenantAiProviders.testAiCreds),
);
// Lista os modelos disponíveis do provedor (seletor inteligente do modal).
router.post(
  '/ai/providers/models',
  adminOnly,
  validate({ body: listAiModelsSchema }),
  asyncHandler(tenantAiProviders.listModels),
);
router.patch(
  '/ai/providers/:id',
  adminOnly,
  validate({ params: aiProviderIdParamSchema, body: updateAiProviderSchema }),
  asyncHandler(tenantAiProviders.patchAiProvider),
);
router.delete(
  '/ai/providers/:id',
  adminOnly,
  validate({ params: aiProviderIdParamSchema }),
  asyncHandler(tenantAiProviders.removeAiProvider),
);
router.post(
  '/ai/providers/:id/test',
  adminOnly,
  validate({ params: aiProviderIdParamSchema }),
  asyncHandler(tenantAiProviders.testAiProvider),
);

export default router;
