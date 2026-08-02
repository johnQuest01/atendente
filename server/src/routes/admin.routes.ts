import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate, requireSuperAdmin } from '../middleware/auth.middleware';
import {
  getTenants,
  postTenant,
  createTenantSchema,
  patchTenant,
  updateTenantSchema,
  tenantIdParamSchema,
} from '../controllers/admin.controller';
import {
  postInvite,
  createInviteSchema,
  getInvites,
  deleteInvite,
  inviteIdParamSchema,
} from '../controllers/invites.controller';
import {
  adminAiProviders,
  createAiProviderSchema,
  updateAiProviderSchema,
  aiProviderIdParamSchema,
  testAiCredsSchema,
  listAiModelsSchema,
} from '../controllers/ai_providers.controller';

const router = Router();

// Todas as rotas exigem o dono da plataforma (super-admin).
router.use(authenticate, requireSuperAdmin);

router.get('/tenants', asyncHandler(getTenants));
router.post('/tenants', validate({ body: createTenantSchema }), asyncHandler(postTenant));
router.patch(
  '/tenants/:id',
  validate({ params: tenantIdParamSchema, body: updateTenantSchema }),
  asyncHandler(patchTenant),
);

// Convites de acesso: como ainda não há gateway de pagamento, é assim que uma
// empresa nova entra na plataforma (link + período de teste).
router.get('/invites', asyncHandler(getInvites));
router.post('/invites', validate({ body: createInviteSchema }), asyncHandler(postInvite));
router.delete(
  '/invites/:id',
  validate({ params: inviteIdParamSchema }),
  asyncHandler(deleteInvite),
);

// Provedores de IA GLOBAIS da plataforma (trocar de agente + cadeia de failover).
router.get('/ai/providers', asyncHandler(adminAiProviders.getAiProviders));
router.post(
  '/ai/providers',
  validate({ body: createAiProviderSchema }),
  asyncHandler(adminAiProviders.postAiProvider),
);
router.post(
  '/ai/providers/test',
  validate({ body: testAiCredsSchema }),
  asyncHandler(adminAiProviders.testAiCreds),
);
// Lista os modelos disponíveis do provedor (seletor inteligente do modal).
router.post(
  '/ai/providers/models',
  validate({ body: listAiModelsSchema }),
  asyncHandler(adminAiProviders.listModels),
);
router.patch(
  '/ai/providers/:id',
  validate({ params: aiProviderIdParamSchema, body: updateAiProviderSchema }),
  asyncHandler(adminAiProviders.patchAiProvider),
);
router.delete(
  '/ai/providers/:id',
  validate({ params: aiProviderIdParamSchema }),
  asyncHandler(adminAiProviders.removeAiProvider),
);
router.post(
  '/ai/providers/:id/test',
  validate({ params: aiProviderIdParamSchema }),
  asyncHandler(adminAiProviders.testAiProvider),
);

export default router;
