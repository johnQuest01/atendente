import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { requireActiveTenant } from '../middleware/tenantAccess.middleware';
import { authenticate } from '../middleware/auth.middleware';
import {
  clearConversation,
  clientAiSchema,
  patchConversationClient,
  deleteMessagesSchema,
  editMessage,
  editMessageSchema,
  getChatLockStatus,
  getConversations,
  getConversationDetail,
  idParamSchema,
  listQuerySchema,
  lockChatSchema,
  messageIdParamSchema,
  patchConversationLock,
  patchConversationStatus,
  putChatLockPassword,
  chatLockPasswordSchema,
  removeConversation,
  removeMessages,
  sendAudioSchema,
  sendManualAudio,
  sendManualMessage,
  sendManualProduct,
  sendMessageSchema,
  sendProductSchema,
  statusBodySchema,
  unlockChatSchema,
  unlockConversation,
} from '../controllers/conversations.controller';
import {
  conversationIdParamSchema,
  conversationMemoryParamSchema,
  listMemoriesForConversation,
  removeMemoryForConversation,
} from '../controllers/memories.controller';

const router = Router();

router.use(authenticate, requireActiveTenant);

router.get('/chat-lock', asyncHandler(getChatLockStatus));
router.put(
  '/chat-lock',
  validate({ body: chatLockPasswordSchema }),
  asyncHandler(putChatLockPassword),
);
router.get('/', validate({ query: listQuerySchema }), asyncHandler(getConversations));
router.get('/:id', validate({ params: idParamSchema }), asyncHandler(getConversationDetail));
router.post(
  '/:id/unlock',
  validate({ params: idParamSchema, body: unlockChatSchema }),
  asyncHandler(unlockConversation),
);
router.patch(
  '/:id/lock',
  validate({ params: idParamSchema, body: lockChatSchema }),
  asyncHandler(patchConversationLock),
);
router.get(
  '/:id/memories',
  validate({ params: conversationIdParamSchema }),
  asyncHandler(listMemoriesForConversation),
);
router.delete(
  '/:id/memories/:memoryId',
  validate({ params: conversationMemoryParamSchema }),
  asyncHandler(removeMemoryForConversation),
);
router.patch(
  '/:id/status',
  validate({ params: idParamSchema, body: statusBodySchema }),
  asyncHandler(patchConversationStatus),
);
// Ajuste da IA para o contato desta conversa (desligar / prompt próprio).
router.patch(
  '/:id/client',
  validate({ params: idParamSchema, body: clientAiSchema }),
  asyncHandler(patchConversationClient),
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
router.patch(
  '/:id/messages/:messageId',
  validate({ params: messageIdParamSchema, body: editMessageSchema }),
  asyncHandler(editMessage),
);
router.delete('/:id/messages', validate({ params: idParamSchema }), asyncHandler(clearConversation));
router.delete('/:id', validate({ params: idParamSchema }), asyncHandler(removeConversation));

export default router;
