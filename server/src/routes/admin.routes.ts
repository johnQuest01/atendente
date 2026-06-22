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
  adminAiProviders,
  createAiProviderSchema,
  updateAiProviderSchema,
  aiProviderIdParamSchema,
  testAiCredsSchema,
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
