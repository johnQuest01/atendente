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

export default router;
