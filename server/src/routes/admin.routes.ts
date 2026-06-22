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
  getAiProviders,
  postAiProvider,
  createAiProviderSchema,
  patchAiProvider,
  updateAiProviderSchema,
  removeAiProvider,
  aiProviderIdParamSchema,
  testAiProvider,
  testAiCreds,
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

// Provedores de IA da plataforma (trocar de agente + cadeia de failover).
router.get('/ai/providers', asyncHandler(getAiProviders));
router.post('/ai/providers', validate({ body: createAiProviderSchema }), asyncHandler(postAiProvider));
router.post('/ai/providers/test', validate({ body: testAiCredsSchema }), asyncHandler(testAiCreds));
router.patch(
  '/ai/providers/:id',
  validate({ params: aiProviderIdParamSchema, body: updateAiProviderSchema }),
  asyncHandler(patchAiProvider),
);
router.delete(
  '/ai/providers/:id',
  validate({ params: aiProviderIdParamSchema }),
  asyncHandler(removeAiProvider),
);
router.post(
  '/ai/providers/:id/test',
  validate({ params: aiProviderIdParamSchema }),
  asyncHandler(testAiProvider),
);

export default router;
