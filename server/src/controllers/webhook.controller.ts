import type { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { findOrCreateClient, updateClient } from '../db/queries/clients';
import {
  findOpenConversationByClient,
  findOrCreateOpenConversation,
  getRecentMessagesForAI,
} from '../db/queries/conversations';
import { listProducts } from '../db/queries/products';
import { insertMessage, markDelivered, markRead } from '../db/queries/messages';
import { isAgentEnabled } from '../db/queries/settings';
import { isPhoneBlocked } from '../db/queries/blocked';
import { emitNewMessage, emitNewConversation } from '../socket';
import { matchIntent, getTriggerPhrases } from '../services/matcher.service';
import { extractClientInfo, generateReply } from '../services/claude.service';
import {
  transcribeAudioFromBase64,
  transcribeAudioFromUrl,
} from '../services/transcription.service';
import type { AiHistoryMessage, Client } from '../types';
import {
  dispatchAudio,
  dispatchScript,
  dispatchProduct,
  dispatchText,
} from '../services/dispatch.service';
import {
  markAsRead,
  parseInbound,
  parseStatusUpdate,
  type NormalizedInbound,
} from '../services/whatsapp.service';

/**
 * Orquestrador principal da IA. Recebe mensagens do provedor de WhatsApp
 * ativo (Z-API ou Evolution API — normalizado pelo whatsapp.service),
 * registra, classifica a intenção e responde automaticamente.
 */
export async function handleWhatsappWebhook(req: Request, res: Response): Promise<void> {
  // Validação opcional de token de webhook.
  if (env.WEBHOOK_VERIFY_TOKEN) {
    const token = (req.query.token as string) ?? req.headers['x-webhook-token'];
    if (token !== env.WEBHOOK_VERIFY_TOKEN) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Token de webhook inválido.' } });
      return;
    }
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  // Callbacks de status de entrega/leitura.
  const statusUpdate = parseStatusUpdate(body);
  if (statusUpdate) {
    for (const id of statusUpdate.ids) {
      if (statusUpdate.status === 'READ') await markRead(id);
      else await markDelivered(id);
    }
    res.status(200).json({ ok: true });
    return;
  }

  const inbound = parseInbound(body);
  if (!inbound) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  // Ignora mensagens enviadas pela própria conta.
  if (inbound.fromMe) {
    res.status(200).json({ ok: true, ignored: 'fromMe' });
    return;
  }

  // Número bloqueado: ignora totalmente (não salva, não responde, não exibe).
  if (await isPhoneBlocked(inbound.phone)) {
    logger.info(`Mensagem de número bloqueado ignorada: ${inbound.phone}`);
    res.status(200).json({ ok: true, ignored: 'blocked' });
    return;
  }

  // Responde rápido ao provedor; processa o resto de forma assíncrona.
  res.status(200).json({ ok: true });

  void processInbound(inbound).catch((err) => {
    logger.error('Erro ao processar mensagem inbound', err);
  });
}

async function processInbound(inbound: NormalizedInbound): Promise<void> {
  const client = await findOrCreateClient(inbound.phone, inbound.senderName);

  const existing = await findOpenConversationByClient(client.id);
  const conversation = existing ?? (await findOrCreateOpenConversation(client.id));
  if (!existing) emitNewConversation(conversation);

  // Lê o flag global (com cache): se o atendente de IA estiver desligado, um
  // humano vai responder — então NÃO chamamos Claude/Z-API para responder.
  const agentEnabled = await isAgentEnabled();

  // Áudio recebido do cliente: tenta transcrever para que a IA "entenda".
  // Mantemos a transcrição mesmo com o agente desligado, pois ajuda o operador
  // humano a ler o conteúdo do áudio direto no painel.
  let transcription: string | null = null;
  if (inbound.type === 'audio') {
    transcription = await transcribeInboundAudio(inbound);
    if (transcription) {
      logger.info(`Áudio do cliente transcrito (${transcription.length} chars).`);
    }
  }

  const inboundMsg = await insertMessage({
    conversationId: conversation.id,
    direction: 'inbound',
    type: inbound.type,
    // Para áudio, guardamos a transcrição como conteúdo (cai no histórico da IA).
    content: transcription ?? inbound.text,
    zapiMessageId: inbound.messageId,
  });
  emitNewMessage(conversation.id, inboundMsg);

  // Agente desligado: mensagem registrada e exibida no painel, sem resposta
  // automática e sem tique azul (o humano decide quando ler/responder).
  if (!agentEnabled) {
    logger.info('Atendente de IA desligado — mensagem registrada, sem resposta automática.');
    return;
  }

  // Marca a mensagem como lida no WhatsApp (tique azul): o cliente vê que a
  // Mayra "abriu" o áudio/mensagem. Best-effort, não bloqueia a resposta.
  if (inbound.messageId) {
    void markAsRead(inbound.phone, inbound.messageId).catch((err) =>
      logger.warn('Falha ao marcar mensagem como lida (tique azul)', err),
    );
  }

  const ctx = { conversation, client };

  // Texto efetivo para responder: texto puro ou a transcrição do áudio.
  let replyText: string | null = null;
  if (inbound.type === 'text') replyText = inbound.text;
  else if (inbound.type === 'audio') replyText = transcription;

  if (!replyText) {
    // Áudio que não conseguimos transcrever: em vez de ficar mudo, avisamos o
    // cliente (continua útil mesmo sem speech-to-text configurado).
    if (inbound.type === 'audio') {
      if (!env.hasStt) {
        logger.warn('Áudio recebido, mas transcrição (STT) não está configurada.');
      }
      await dispatchText(
        ctx,
        'Recebi seu áudio! 🎧 Pra eu te responder certinho, consegue me mandar por mensagem de texto também?',
      ).catch((err) => logger.warn('Falha ao responder áudio sem transcrição', err));
    }
    return;
  }

  // Histórico enriquecido (transcrição de áudios + nome de produtos enviados).
  const history = await getRecentMessagesForAI(conversation.id, 20);

  // Coleta de dados do cliente em segundo plano (não bloqueia a resposta).
  if (env.hasAnthropic) {
    void enrichClientFromConversation(client, history).catch((err) =>
      logger.warn('Falha ao enriquecer cliente', err),
    );
  }

  const match = await matchIntent(replyText);

  if (match.content_type === 'audio' && match.content_id) {
    const sent = await dispatchAudio(ctx, match.content_id);
    if (sent) return;
  } else if (match.content_type === 'text' && match.content_id) {
    const sent = await dispatchScript(ctx, match.content_id);
    if (sent) return;
  } else if (match.content_type === 'product' && match.content_id) {
    const sent = await dispatchProduct(ctx, match.content_id);
    if (sent) return;
  }

  // Fallback: Claude com histórico + catálogo de produtos disponíveis.
  const products = await listProducts(true);
  const reply = await generateReply({
    history,
    client,
    products,
    storeName: env.STORE_NAME,
  });
  if (reply) {
    await dispatchText(ctx, reply);
  } else {
    logger.warn('Sem resposta automática disponível (Claude indisponível e nenhum match).');
  }
}

/**
 * Transcreve o áudio recebido do cliente usando o provedor de STT configurado.
 * Aceita tanto URL pública (Z-API) quanto base64 (Evolution). Retorna null se
 * a transcrição estiver desativada ou se não houver mídia utilizável.
 */
async function transcribeInboundAudio(inbound: NormalizedInbound): Promise<string | null> {
  if (!env.hasStt) return null;
  const prompt = await buildTranscriptionPrompt();
  if (inbound.mediaBase64) {
    const fromB64 = await transcribeAudioFromBase64(inbound.mediaBase64, prompt);
    if (fromB64) return fromB64;
  }
  if (inbound.mediaUrl) {
    return transcribeAudioFromUrl(inbound.mediaUrl, prompt);
  }
  return null;
}

/**
 * Monta o "prompt" de contexto para o Whisper: idioma + frases-gatilho
 * cadastradas. Isso reduz erros em áudios curtos (ex.: "não entendi").
 */
async function buildTranscriptionPrompt(): Promise<string> {
  const base = 'Mensagem de voz de um cliente no WhatsApp, em português do Brasil.';
  try {
    const phrases = await getTriggerPhrases();
    if (phrases.length === 0) return base;
    return `${base} Frases comuns: ${phrases.join('; ')}.`;
  } catch {
    return base;
  }
}

/**
 * Extrai dados do cliente da conversa via IA e preenche APENAS os campos
 * que ainda estão vazios no cadastro (nunca sobrescreve dado existente).
 */
async function enrichClientFromConversation(
  client: Client,
  history: AiHistoryMessage[],
): Promise<void> {
  // Só vale a pena se houver algum campo faltando.
  const missing = !client.name || !client.company_name || !client.segment || !client.notes;
  if (!missing) return;

  const info = await extractClientInfo(history);
  if (!info) return;

  const patch: Record<string, string> = {};
  if (!client.name && info.name) patch.name = info.name;
  if (!client.company_name && info.company_name) patch.company_name = info.company_name;
  if (!client.segment && info.segment) patch.segment = info.segment;
  // notes sempre pode ser atualizado com o interesse mais recente.
  if (info.notes) patch.notes = info.notes;

  if (Object.keys(patch).length === 0) return;
  await updateClient(client.id, patch);
  logger.info(`Dados do cliente ${client.id} atualizados via IA`, patch);
}
