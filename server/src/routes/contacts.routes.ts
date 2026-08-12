import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import { requireActiveTenant } from '../middleware/tenantAccess.middleware';
import {
  exportContactsJson,
  exportContactsVcf,
  importContactsJson,
  pasteImport,
  pasteImportSchema,
  syncWhatsappContacts,
} from '../controllers/contacts.controller';

const router = Router();

router.use(authenticate, requireActiveTenant);

router.get('/export.vcf', asyncHandler(exportContactsVcf));
router.get('/export.json', asyncHandler(exportContactsJson));
router.post('/import', asyncHandler(importContactsJson));
router.post('/sync-whatsapp', asyncHandler(syncWhatsappContacts));
router.post('/paste-import', validate({ body: pasteImportSchema }), asyncHandler(pasteImport));

export default router;
