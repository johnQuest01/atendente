import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  deleteConversation,
  getConversationById,
  getConversationMessages,
  listConversations,
  markInboundAsRead,
  setConversationLocked,
  updateConversationStatus,
} from '../db/queries/conversations';
import {
  deleteAllMessages,
  deleteMessages,
  getMessageById,
  getMessagesByIds,
  updateMessageContent,
} from '../db/queries/messages';
import { updateClient } from '../db/queries/clients';
import { queryOne } from '../db/index';
import { dispatchAudio, dispatchProduct, dispatchText } from '../services/dispatch.service';
import {
  getTenantWhatsapp,
  getWhatsappByConnection,
} from '../services/whatsapp.service';
import {
  isChatLockConfigured,
  setChatLockPassword,
  signChatUnlockToken,
  verifyChatLockPassword,
  verifyChatUnlockToken,
} from '../services/chat-lock.service';
import { emitConversationUpdated, emitNewMessage } from '../socket';
import { AppError, NotFoundError } from '../utils/errors';
import type { Client } from '../types';

export const listQuerySchema = z.object({
  status: z.enum(['open', 'closed', 'waiting']).optional(),
  /** Filtra conversas de um número/instância WhatsApp. */
  connectionId: z.string().uuid().optional(),
});

export const idParamSchema = z.object({ id: z.string().uuid() });

export const statusBodySchema = z.object({
  status: z.enum(['open', 'closed', 'waiting']),
});

export const sendMessageSchema = z.object({
  text: z.string().min(1).max(4096),
});

export const sendAudioSchema = z.object({
  audio_id: z.string().uuid(),
});

export const sendProductSchema = z.object({
  product_id: z.string().uuid(),
  /** false = envia foto/nome/mínimo sem revelar o preço na legenda. Default true. */
  with_price: z.boolean().optional().default(true),
});

export const deleteMessagesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  /**
   * true (padrão) = tenta apagar no WhatsApp para todos, depois remove do painel.
   * false = só remove do painel (histórico local).
   */
  forEveryone: z.boolean().optional().default(true),
});

export const editMessageSchema = z.object({
  text: z.string().trim().min(1).max(4096),
});

export const messageIdParamSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
});

/** Busca o cliente garantindo que ele pertence ao tenant da requisição. */
function findTenantClient(tenantId: string, clientId: string): Promise<Client | null> {
  return queryOne<Client>('SELECT * FROM clients WHERE id = $1 AND tenant_id = $2', [
    clientId,
    tenantId,
  ]);
}

export async function getConversations(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { status, connectionId } = req.query as z.infer<typeof listQuerySchema>;
  const conversations = await listConversations(tenantId, status, connectionId);
  res.json({ conversations });
}

export async function getConversationDetail(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');

  const client = await findTenantClient(tenantId, conversation.client_id);
  const lockConfigured = await isChatLockConfigured(tenantId);
  const unlockHeader = req.header('x-chat-unlock') ?? undefined;
  const unlocked =
    !conversation.is_locked ||
    verifyChatUnlockToken(unlockHeader, tenantId, id);

  if (conversation.is_locked && !unlocked) {
    res.json({
      conversation,
      client,
      messages: [],
      locked: true,
      lock_configured: lockConfigured,
    });
    return;
  }

  const messages = await getConversationMessages(tenantId, id);
  await markInboundAsRead(tenantId, id);

  res.json({
    conversation,
    client,
    messages,
    locked: false,
    lock_configured: lockConfigured,
  });
}

export const chatLockPasswordSchema = z.object({
  password: z.string().min(4).max(72),
  currentPassword: z.string().min(1).max(72).optional().nullable(),
});

export const unlockChatSchema = z.object({
  password: z.string().min(1).max(72),
});

export const lockChatSchema = z.object({
  locked: z.boolean(),
  /** Obrigatória para destrancar o cadeado (locked=false). */
  password: z.string().min(1).max(72).optional(),
  /** Ao trancar pela 1ª vez, define a senha do tenant se ainda não houver. */
  newPassword: z.string().min(4).max(72).optional(),
});

/** Define/troca a senha do cadeado de conversas (tenant). */
export async function putChatLockPassword(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const body = req.body as z.infer<typeof chatLockPasswordSchema>;
  await setChatLockPassword(tenantId, body.password, body.currentPassword);
  res.json({ ok: true, configured: true });
}

export async function getChatLockStatus(req: Request, res: Response): Promise<void> {
  const configured = await isChatLockConfigured(req.user!.tenant_id);
  res.json({ configured });
}

/** Valida senha e devolve token temporário para ver a conversa trancada. */
export async function unlockConversation(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { password } = req.body as z.infer<typeof unlockChatSchema>;

  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');
  if (!conversation.is_locked) {
    res.json({ ok: true, token: null, unlocked: true });
    return;
  }
  if (!(await isChatLockConfigured(tenantId))) {
    throw new AppError('Defina uma senha do cadeado antes.', 400, 'CHAT_LOCK_NOT_CONFIGURED');
  }
  const ok = await verifyChatLockPassword(tenantId, password);
  if (!ok) throw new AppError('Senha incorreta.', 403, 'CHAT_LOCK_BAD_PASSWORD');

  const token = signChatUnlockToken(tenantId, id);
  res.json({ ok: true, token, unlocked: true });
}

/** Tranca/destranca a conversa no painel. */
export async function patchConversationLock(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof lockChatSchema>;

  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');

  if (body.locked) {
    const configured = await isChatLockConfigured(tenantId);
    if (!configured) {
      if (!body.newPassword?.trim()) {
        throw new AppError(
          'Crie uma senha do cadeado (mín. 4 caracteres) para trancar conversas.',
          400,
          'CHAT_LOCK_NEED_PASSWORD',
        );
      }
      await setChatLockPassword(tenantId, body.newPassword);
    }
    const updated = await setConversationLocked(tenantId, id, true);
    if (updated) emitConversationUpdated(tenantId, updated);
    res.json({ conversation: updated, lock_configured: true });
    return;
  }

  // Remover cadeado exige senha.
  if (!(await isChatLockConfigured(tenantId))) {
    const updated = await setConversationLocked(tenantId, id, false);
    if (updated) emitConversationUpdated(tenantId, updated);
    res.json({ conversation: updated, lock_configured: false });
    return;
  }
  if (!body.password?.trim()) {
    throw new AppError('Informe a senha para remover o cadeado.', 400, 'CHAT_LOCK_PASSWORD_REQUIRED');
  }
  const ok = await verifyChatLockPassword(tenantId, body.password);
  if (!ok) throw new AppError('Senha incorreta.', 403, 'CHAT_LOCK_BAD_PASSWORD');

  const updated = await setConversationLocked(tenantId, id, false);
  if (updated) emitConversationUpdated(tenantId, updated);
  res.json({ conversation: updated, lock_configured: true });
}

export const clientAiSchema = z
  .object({
    ai_enabled: z.boolean().optional(),
    // String vazia limpa o prompt; ausente mantém o atual.
    ai_prompt: z.string().trim().max(2000).optional(),
  })
  .refine((d) => d.ai_enabled !== undefined || d.ai_prompt !== undefined, {
    message: 'Informe ao menos um campo para atualizar.',
  });

/**
 * Ajusta o comportamento da IA para o contato DESTA conversa: desligar a
 * resposta automática só para ele, e/ou dar instruções específicas.
 */
export async function patchConversationClient(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const patch = req.body as z.infer<typeof clientAiSchema>;

  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');

  const client = await updateClient(tenantId, conversation.client_id, patch);
  if (!client) throw new NotFoundError('Contato');

  res.json({ client });
}

export async function patchConversationStatus(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { status } = req.body as z.infer<typeof statusBodySchema>;

  const conversation = await updateConversationStatus(tenantId, id, status);
  if (!conversation) throw new NotFoundError('Conversa');

  emitConversationUpdated(tenantId, conversation);
  res.json({ conversation });
}

/** Envio manual de texto pela atendente. */
export async function sendManualMessage(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { text } = req.body as z.infer<typeof sendMessageSchema>;

  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');

  const client = await findTenantClient(tenantId, conversation.client_id);
  if (!client) throw new NotFoundError('Cliente');

  // Operador digitou no painel — origin 'human' para a IA não tratar como resposta dela.
  const message = await dispatchText({ conversation, client }, text, { origin: 'human' });
  res.status(201).json({ message });
}

/** Envio manual de um áudio do banco pela atendente. */
export async function sendManualAudio(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { audio_id } = req.body as z.infer<typeof sendAudioSchema>;

  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');
  const client = await findTenantClient(tenantId, conversation.client_id);
  if (!client) throw new NotFoundError('Cliente');

  const message = await dispatchAudio({ conversation, client }, audio_id);
  if (!message) throw new NotFoundError('Áudio');
  res.status(201).json({ message });
}

/** Apaga mensagens selecionadas — no WhatsApp (para todos) e/ou só no painel. */
export async function removeMessages(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { ids, forEveryone } = req.body as z.infer<typeof deleteMessagesSchema>;

  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');
  const client = await findTenantClient(tenantId, conversation.client_id);
  if (!client) throw new NotFoundError('Cliente');

  let whatsappOk = 0;
  let whatsappFailed = 0;
  const failures: string[] = [];

  if (forEveryone) {
    const rows = await getMessagesByIds(tenantId, id, ids);
    const wa = conversation.connection_id
      ? await getWhatsappByConnection(tenantId, conversation.connection_id)
      : await getTenantWhatsapp(tenantId);

    for (const row of rows) {
      if (!row.zapi_message_id || !wa.deleteMessage) {
        whatsappFailed += 1;
        failures.push('sem ID do WhatsApp');
        continue;
      }
      const result = await wa.deleteMessage(
        client.phone,
        row.zapi_message_id,
        row.direction === 'outbound',
        false,
      );
      if (result.ok) whatsappOk += 1;
      else {
        whatsappFailed += 1;
        failures.push(result.detail);
      }
    }
  }

  const deleted = await deleteMessages(tenantId, id, ids);
  emitConversationUpdated(tenantId, conversation);
  res.json({
    deleted,
    whatsappOk,
    whatsappFailed,
    detail:
      forEveryone === false
        ? 'Removidas só do painel.'
        : whatsappFailed === 0
          ? `Apagadas no WhatsApp (para todos) e no painel (${deleted}).`
          : `Painel: ${deleted}. WhatsApp: ${whatsappOk} ok, ${whatsappFailed} falhou${
              failures[0] ? ` (${failures[0]})` : ''
            }.`,
  });
}

/** Corrige texto de uma mensagem outbound no WhatsApp e no painel. */
export async function editMessage(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id, messageId } = req.params as z.infer<typeof messageIdParamSchema>;
  const { text } = req.body as z.infer<typeof editMessageSchema>;

  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');
  const client = await findTenantClient(tenantId, conversation.client_id);
  if (!client) throw new NotFoundError('Cliente');

  const existing = await getMessageById(tenantId, id, messageId);
  if (!existing) throw new NotFoundError('Mensagem');
  if (existing.direction !== 'outbound' || existing.type !== 'text') {
    throw new AppError('Só é possível corrigir textos enviados por você.', 400, 'EDIT_NOT_ALLOWED');
  }
  if (!existing.zapi_message_id) {
    throw new AppError(
      'Esta mensagem não tem ID do WhatsApp — não dá para corrigir no celular do cliente.',
      400,
      'MISSING_WA_ID',
    );
  }

  const wa = conversation.connection_id
    ? await getWhatsappByConnection(tenantId, conversation.connection_id)
    : await getTenantWhatsapp(tenantId);

  if (!wa.editText) {
    throw new AppError('Seu provedor de WhatsApp não permite editar mensagens.', 400, 'EDIT_UNSUPPORTED');
  }

  try {
    await wa.editText(client.phone, existing.zapi_message_id, text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(
      `WhatsApp recusou a correção (limite de ~7 dias ou mensagem inválida): ${msg}`,
      502,
      'WA_EDIT_FAILED',
    );
  }

  const updated = await updateMessageContent(tenantId, id, messageId, text);
  if (!updated) throw new NotFoundError('Mensagem');

  emitNewMessage(tenantId, id, updated);
  emitConversationUpdated(tenantId, conversation);
  res.json({ message: updated });
}

/** Apaga a conversa inteira (some da lista) junto com suas mensagens. */
export async function removeConversation(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const ok = await deleteConversation(tenantId, id);
  if (!ok) throw new NotFoundError('Conversa');
  res.status(204).send();
}

/** Limpa todo o histórico de mensagens de uma conversa. */
export async function clearConversation(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');

  const deleted = await deleteAllMessages(tenantId, id);
  res.json({ deleted });
}

/** Envio manual de um produto pela atendente. */
export async function sendManualProduct(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { product_id, with_price } = req.body as z.infer<typeof sendProductSchema>;

  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');
  const client = await findTenantClient(tenantId, conversation.client_id);
  if (!client) throw new NotFoundError('Cliente');

  const message = await dispatchProduct({ conversation, client }, product_id, {
    withPrice: with_price,
  });
  if (!message) throw new NotFoundError('Produto');
  res.status(201).json({ message });
}
