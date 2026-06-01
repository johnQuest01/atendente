import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import {
  clearConversation,
  deleteMessagesSchema,
  getConversations,
  getConversationDetail,
  idParamSchema,
  listQuerySchema,
  patchConversationStatus,
  removeConversation,
  removeMessages,
  sendAudioSchema,
  sendManualAudio,
  sendManualMessage,
  sendManualProduct,
  sendMessageSchema,
  sendProductSchema,
  statusBodySchema,
} from '../controllers/conversations.controller';

const router = Router();

router.use(authenticate);

router.get('/', validate({ query: listQuerySchema }), asyncHandler(getConversations));
router.get('/:id', validate({ params: idParamSchema }), asyncHandler(getConversationDetail));
router.patch(
  '/:id/status',
  validate({ params: idParamSchema, body: statusBodySchema }),
  asyncHandler(patchConversationStatus),
);
router.post(
  '/:id/messages',
  validate({ params: idParamSchema, body: sendMessageSchema }),
  asyncHandler(sendManualMessage),
);
router.post(
  '/:id/audio',
  validate({ params: idParamSchema, body: sendAudioSchema }),
  asyncHandler(sendManualAudio),
);
router.post(
  '/:id/product',
  validate({ params: idParamSchema, body: sendProductSchema }),
  asyncHandler(sendManualProduct),
);
router.post(
  '/:id/messages/delete',
  validate({ params: idParamSchema, body: deleteMessagesSchema }),
  asyncHandler(removeMessages),
);
router.delete('/:id/messages', validate({ params: idParamSchema }), asyncHandler(clearConversation));
router.delete('/:id', validate({ params: idParamSchema }), asyncHandler(removeConversation));

export default router;
