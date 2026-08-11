import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { requireActiveTenant } from '../middleware/tenantAccess.middleware';
import {
  connectBodySchema,
  connectionIdParamSchema,
  getConnectQr,
  getConnectStatus,
  phoneCodeBodySchema,
  postActivatePaid,
  postConnect,
  postConnectForTenant,
  postDisconnect,
  postPhoneCode,
  postReconnect,
  tenantIdParamSchema,
} from '../controllers/whatsapp-onboarding.controller';

const router = Router();
const adminOnly = authorize('admin', 'superadmin');

router.use(authenticate, requireActiveTenant);

// Fluxo principal (tenant do JWT)
router.post(
  '/connect',
  adminOnly,
  validate({ body: connectBodySchema }),
  asyncHandler(postConnect),
);
router.get(
  '/connect/:connectionId/qr',
  adminOnly,
  validate({ params: connectionIdParamSchema }),
  asyncHandler(getConnectQr),
);
router.post(
  '/connect/:connectionId/phone-code',
  adminOnly,
  validate({ params: connectionIdParamSchema, body: phoneCodeBodySchema }),
  asyncHandler(postPhoneCode),
);
router.get(
  '/connect/:connectionId/status',
  adminOnly,
  validate({ params: connectionIdParamSchema }),
  asyncHandler(getConnectStatus),
);
router.post(
  '/connect/:connectionId/disconnect',
  adminOnly,
  validate({ params: connectionIdParamSchema }),
  asyncHandler(postDisconnect),
);
router.post(
  '/connect/:connectionId/reconnect',
  adminOnly,
  validate({
    params: connectionIdParamSchema,
    body: connectBodySchema.partial().default({}),
  }),
  asyncHandler(postReconnect),
);

export default router;

/** Rotas no formato do prompt: /tenants/:tenantId/whatsapp/... */
export const tenantWhatsappRouter = Router({ mergeParams: true });

tenantWhatsappRouter.use(authenticate, requireActiveTenant);

tenantWhatsappRouter.post(
  '/connect',
  adminOnly,
  validate({ params: tenantIdParamSchema, body: connectBodySchema }),
  asyncHandler(postConnectForTenant),
);

tenantWhatsappRouter.post(
  '/activate-paid',
  adminOnly,
  validate({ params: tenantIdParamSchema }),
  asyncHandler(postActivatePaid),
);
