import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import {
  acceptInvite,
  acceptInviteSchema,
  getInvitePreview,
  inviteTokenParamSchema,
} from '../controllers/invites.controller';

/**
 * Rotas PÚBLICAS do convite (sem autenticação): quem recebe o link ainda não
 * tem conta. O token opaco é a credencial, e o aceite já devolve a sessão.
 */
const router = Router();

router.get(
  '/:token',
  validate({ params: inviteTokenParamSchema }),
  asyncHandler(getInvitePreview),
);

router.post(
  '/:token/accept',
  validate({ params: inviteTokenParamSchema, body: acceptInviteSchema }),
  asyncHandler(acceptInvite),
);

export default router;
