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
  getReminderPersonaHandler,
  putReminderPersona,
  updateReminderPersonaSchema,
  getBehaviorSettings,
  putBehaviorSetting,
  behaviorKeyParamSchema,
  updateBehaviorSchema,
  getMemoryScan,
  putMemoryScan,
  updateMemoryScanSchema,
  getSystemStatus,
  getWhatsappConnection,
  configureWhatsappWebhook,
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
import { getMyAccessToken } from '../controllers/access-tokens.controller';

const router = Router();

router.use(authenticate, requireActiveTenant);

const adminOnly = authorize('admin', 'superadmin');

router.get('/agent', asyncHandler(getAgentStatus));
router.put('/agent', validate({ body: updateAgentSchema }), asyncHandler(putAgentStatus));

router.get('/persona', asyncHandler(getPersona));
router.put('/persona', validate({ body: updatePersonaSchema }), asyncHandler(putPersona));
// Playground: testa o prompt gerando uma resposta de exemplo (sem enviar WhatsApp).
// Aceita target: 'sales' (padrão) ou 'reminder' (persona do assistente de lembretes).
router.post('/persona/preview', validate({ body: previewPersonaSchema }), asyncHandler(previewPersona));

// Persona do assistente de lembretes (como a "secretária" fala com o dono).
router.get('/reminder-persona', adminOnly, asyncHandler(getReminderPersonaHandler));
router.put(
  '/reminder-persona',
  adminOnly,
  validate({ body: updateReminderPersonaSchema }),
  asyncHandler(putReminderPersona),
);

// Registro de comportamento (config-driven): ajustes simples, editáveis no painel.
router.get('/behavior', adminOnly, asyncHandler(getBehaviorSettings));
router.put(
  '/behavior/:key',
  adminOnly,
  validate({ params: behaviorKeyParamSchema, body: updateBehaviorSchema }),
  asyncHandler(putBehaviorSetting),
);

// Varredura de conversas (recuperar compromissos): liga/desliga (OFF por padrão).
router.get('/memory-scan', adminOnly, asyncHandler(getMemoryScan));
router.put(
  '/memory-scan',
  adminOnly,
  validate({ body: updateMemoryScanSchema }),
  asyncHandler(putMemoryScan),
);

// Status REAL das integrações (banco, Claude, WhatsApp, STT).
router.get('/status', asyncHandler(getSystemStatus));

// Token de acesso da empresa do usuário logado (só-leitura, escopado por tenant).
// Visível a qualquer papel DAQUELA empresa — é o "exposto pra ele e pra quem loga".
router.get('/access-token', asyncHandler(getMyAccessToken));

// Conexão de WhatsApp da empresa (cadastro de credenciais). Só admin edita.
router.get('/whatsapp', asyncHandler(getWhatsappConnection));
router.put(
  '/whatsapp',
  adminOnly,
  validate({ body: updateWhatsappSchema }),
  asyncHandler(putWhatsappConnection),
);
// Registra a URL de webhook direto no provedor, sem o cliente colar nada lá.
router.post('/whatsapp/webhook', adminOnly, asyncHandler(configureWhatsappWebhook));

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
// Modelos reais de um provedor JÁ salvo (troca de modelo sem redigitar a chave).
router.post(
  '/ai/providers/:id/models',
  adminOnly,
  validate({ params: aiProviderIdParamSchema }),
  asyncHandler(tenantAiProviders.listModelsForSaved),
);

export default router;
