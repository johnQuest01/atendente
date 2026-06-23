import type { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { DEFAULT_TENANT_ID } from '../config/tenant';
import { runWithTenant } from '../db';
import { findOrCreateClient, updateClient } from '../db/queries/clients';
import {
  findOpenConversationByClient,
  findOrCreateOpenConversation,
  getRecentMessagesForAI,
} from '../db/queries/conversations';
import { listProducts } from '../db/queries/products';
import { listScripts } from '../db/queries/messages_scripts';
import { insertMessage, markDelivered, markRead, inboundMessageExists } from '../db/queries/messages';
import { isAgentEnabled, getAiPersona } from '../db/queries/settings';
import { isPhoneBlocked } from '../db/queries/blocked';
import { emitNewMessage, emitNewConversation } from '../socket';
import { matchIntent, getTriggerPhrases } from '../services/matcher.service';
import { extractClientInfo, generateReply, hasVisionProvider, isAiConfigured } from '../services/ai.service';
import { extractVideoFrames } from '../services/ai/video-frames';
import type { ChatImage } from '../services/ai/types';
import {
  transcribeAudioFromBase64,
  transcribeAudioFromUrl,
} from '../services/transcription.service';
import { persistInboundMedia } from '../services/inbound-media.service';
import type { AiHistoryMessage, Client, Conversation } from '../types';
import {
  dispatchAudio,
  dispatchScript,
  dispatchProduct,
  dispatchText,
} from '../services/dispatch.service';
import {
  getTenantWhatsapp,
  parseInbound,
  parseStatusUpdate,
  type NormalizedInbound,
} from '../services/whatsapp.service';
import {
  getConnectionByWebhookToken,
  type WhatsappProviderName,
} from '../db/queries/whatsapp_connections';

/**
 * Orquestrador principal da IA. Recebe mensagens do provedor de WhatsApp
 * ativo (Z-API ou Evolution API — normalizado pelo whatsapp.service),
 * registra, classifica a intenção e responde automaticamente.
 */
export async function handleWhatsappWebhook(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const webhookToken = req.params.webhookToken as string | undefined;

  // Resolve A QUAL EMPRESA pertence este webhook e qual provedor parsear.
  let tenantId: string;
  let provider: WhatsappProviderName;

  if (webhookToken) {
    // Rota por empresa: o token opaco da URL identifica a conexão.
    const conn = await getConnectionByWebhookToken(webhookToken);
    if (!conn || !conn.is_active) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conexão de webhook não encontrada.' } });
      return;
    }
    tenantId = conn.tenant_id;
    provider = conn.provider;
  } else {
    // Rota legada (sem token): tenant padrão + provedor do .env, protegida pelo
    // WEBHOOK_VERIFY_TOKEN se configurado.
    if (env.WEBHOOK_VERIFY_TOKEN) {
      const token = (req.query.token as string) ?? req.headers['x-webhook-token'];
      if (token !== env.WEBHOOK_VERIFY_TOKEN) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Token de webhook inválido.' } });
        return;
      }
    }
    tenantId = DEFAULT_TENANT_ID;
    provider = env.WHATSAPP_PROVIDER;
  }

  // Callbacks de status de entrega/leitura.
  const statusUpdate = parseStatusUpdate(provider, body);
  if (statusUpdate) {
    for (const id of statusUpdate.ids) {
      if (statusUpdate.status === 'READ') await markRead(tenantId, id);
      else await markDelivered(tenantId, id);
    }
    res.status(200).json({ ok: true });
    return;
  }

  const inbound = parseInbound(provider, body);
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
  if (await isPhoneBlocked(tenantId, inbound.phone)) {
    logger.info(`Mensagem de número bloqueado ignorada: ${inbound.phone}`);
    res.status(200).json({ ok: true, ignored: 'blocked' });
    return;
  }

  // Responde rápido ao provedor; processa o resto de forma assíncrona.
  res.status(200).json({ ok: true });

  // Processamento no escopo do tenant resolvido (ativa o RLS — BUG 1).
  void runWithTenant(tenantId, () => processInbound(tenantId, inbound)).catch((err) => {
    logger.error('Erro ao processar mensagem inbound', err);
  });
}

async function processInbound(tenantId: string, inbound: NormalizedInbound): Promise<void> {
  // Idempotência: a Z-API pode reenviar o mesmo webhook (retries). Se já
  // registramos esta mensagem, não processamos de novo (evita resposta
  // automática duplicada e custo desnecessário de IA).
  if (inbound.messageId && (await inboundMessageExists(tenantId, inbound.messageId))) {
    logger.info(`Mensagem duplicada ignorada (já processada): ${inbound.messageId}`);
    return;
  }

  const client = await findOrCreateClient(tenantId, inbound.phone, inbound.senderName);

  const existing = await findOpenConversationByClient(tenantId, client.id);
  const conversation = existing ?? (await findOrCreateOpenConversation(tenantId, client.id));
  if (!existing) emitNewConversation(tenantId, conversation);

  // Lê o flag global (com cache): se o atendente de IA estiver desligado, um
  // humano vai responder — então NÃO chamamos Claude/Z-API para responder.
  const agentEnabled = await isAgentEnabled(tenantId);

  // Tique azul IMEDIATO: assim que a IA "vê" a mensagem, marcamos como lida —
  // sem esperar transcrição nem geração de resposta. Best-effort, não bloqueia.
  // (Só quando o agente está ligado; desligado, quem "lê" é o humano.)
  if (agentEnabled && inbound.messageId) {
    const wa = await getTenantWhatsapp(tenantId);
    void wa.markAsRead(inbound.phone, inbound.messageId).catch((err) =>
      logger.warn('Falha ao marcar mensagem como lida (tique azul)', err),
    );
  }

  // Áudio recebido do cliente: tenta transcrever para que a IA "entenda".
  // Mantemos a transcrição mesmo com o agente desligado, pois ajuda o operador
  // humano a ler o conteúdo do áudio direto no painel.
  let transcription: string | null = null;
  if (inbound.type === 'audio') {
    transcription = await transcribeInboundAudio(tenantId, inbound);
    if (transcription) {
      logger.info(`Áudio do cliente transcrito (${transcription.length} chars).`);
    }
  }

  // Re-hospeda a mídia recebida (imagem/vídeo/áudio/documento) numa URL pública
  // ESTÁVEL, para que apareça/toque no painel mesmo após a URL temporária da
  // Z-API expirar. Best-effort: nunca derruba o fluxo se a cópia falhar.
  let mediaUrl: string | null = null;
  let mediaMime: string | null = inbound.mediaMime ?? null;
  if (inbound.type !== 'text' && (inbound.mediaUrl || inbound.mediaBase64)) {
    const stored = await persistInboundMedia(tenantId, {
      type: inbound.type,
      url: inbound.mediaUrl,
      base64: inbound.mediaBase64,
      mime: inbound.mediaMime,
    }).catch((err) => {
      logger.warn('Falha ao re-hospedar mídia recebida', err);
      return null;
    });
    if (stored) {
      mediaUrl = stored.url;
      mediaMime = stored.mime;
    }
  }

  const isAudio = inbound.type === 'audio';
  const inboundMsg = await insertMessage(tenantId, {
    conversationId: conversation.id,
    direction: 'inbound',
    type: inbound.type,
    // Áudio: a transcrição vira o "texto" (cai no histórico da IA). Demais
    // mídias: a legenda (se houver). Texto puro: a própria mensagem.
    content: isAudio ? transcription : inbound.text || null,
    mediaUrl,
    mediaMime,
    transcription: isAudio ? transcription : null,
    zapiMessageId: inbound.messageId,
  });
  emitNewMessage(tenantId, conversation.id, inboundMsg);

  // Agente desligado: mensagem registrada e exibida no painel, sem resposta
  // automática e sem tique azul (o humano decide quando ler/responder).
  if (!agentEnabled) {
    logger.info('Atendente de IA desligado — mensagem registrada, sem resposta automática.');
    return;
  }

  const ctx = { conversation, client };

  // IMAGEM/VÍDEO: rota de VISÃO. A IA "enxerga" a mídia e responde com base no
  // catálogo (ex.: cliente manda foto de um produto perguntando se temos).
  // Pulamos o casamento por palavra-chave — aqui a mídia é o conteúdo principal.
  if (inbound.type === 'image' || inbound.type === 'video') {
    await replyToVisualMedia(tenantId, ctx, inbound, mediaUrl, mediaMime).catch((err) =>
      logger.warn('Falha ao responder mídia visual', err),
    );
    return;
  }

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

  // CAMINHO RÁPIDO: primeiro tentamos casar uma palavra-chave (áudio/script/
  // produto). Se casar, disparamos NA HORA — sem buscar histórico nem catálogo,
  // que só são necessários para o Claude. Isso deixa o envio de áudio bem rápido.
  const match = await matchIntent(tenantId, replyText);
  logger.info(
    `Classificação da mensagem "${replyText.slice(0, 60)}": tipo=${match.content_type} ` +
      `id=${match.content_id ?? 'n/d'} palavra-chave=${match.keyword ?? 'n/d'}`,
  );

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

  // Fallback: a IA precisa do histórico + catálogo de produtos disponíveis.
  const history = await getRecentMessagesForAI(tenantId, conversation.id, 20);

  // Coleta de dados do cliente em segundo plano (não bloqueia a resposta).
  if (await isAiConfigured(tenantId)) {
    void enrichClientFromConversation(tenantId, client, history).catch((err) =>
      logger.warn('Falha ao enriquecer cliente', err),
    );
  }

  const [products, scripts, systemPrompt] = await Promise.all([
    listProducts(tenantId, true),
    listScripts(tenantId, true),
    getAiPersona(tenantId),
  ]);
  const reply = await generateReply(
    {
      history,
      client,
      products,
      scripts,
      storeName: env.STORE_NAME,
      systemPrompt,
    },
    tenantId,
  );
  if (reply) {
    await dispatchText(ctx, reply);
  } else {
    logger.warn('Sem resposta automática disponível (nenhuma IA disponível e nenhum match).');
  }
}

/**
 * Responde a uma IMAGEM/VÍDEO recebido usando VISÃO. Se houver na cadeia da
 * empresa um modelo que enxergue, manda a foto (ou alguns quadros do vídeo) para
 * a IA analisar e responder com base no catálogo. Sem modelo de visão, responde
 * gentilmente pedindo uma descrição em texto (em vez de ficar mudo).
 */
async function replyToVisualMedia(
  tenantId: string,
  ctx: { conversation: Conversation; client: Client },
  inbound: NormalizedInbound,
  persistedUrl: string | null,
  persistedMime: string | null,
): Promise<void> {
  // Sem nenhum provedor com visão na cadeia: não adianta mandar a mídia.
  if (!(await hasVisionProvider(tenantId))) {
    const msg =
      inbound.type === 'video'
        ? 'Recebi seu vídeo! 🎬 Pra eu te ajudar com precisão, me conta por mensagem o que você procura (ou manda uma foto).'
        : 'Recebi sua imagem! 📷 Me conta em uma mensagem o que você precisa que já te ajudo.';
    await dispatchText(ctx, msg).catch((err) => logger.warn('Falha ao responder mídia sem visão', err));
    return;
  }

  // URL estável re-hospedada (R2) é a preferida; cai na URL temporária do provedor.
  const source = persistedUrl ?? inbound.mediaUrl ?? null;

  let images: ChatImage[] = [];
  if (inbound.type === 'image' && source) {
    images = [{ url: source, mime: persistedMime ?? inbound.mediaMime ?? undefined }];
  } else if (inbound.type === 'video' && source) {
    // Vídeo: extrai quadros e manda como imagens (funciona em qualquer IA com visão).
    const frames = await extractVideoFrames(source).catch(() => []);
    images = frames.map((f) => ({ base64: f.base64, mime: f.mime }));
  }

  if (images.length === 0) {
    await dispatchText(
      ctx,
      'Recebi sua mídia! 📎 Me conta em texto o que você precisa que eu te ajudo.',
    ).catch((err) => logger.warn('Falha ao responder mídia sem conteúdo visual', err));
    return;
  }

  const history = await getRecentMessagesForAI(tenantId, ctx.conversation.id, 20);
  const [products, scripts, systemPrompt] = await Promise.all([
    listProducts(tenantId, true),
    listScripts(tenantId, true),
    getAiPersona(tenantId),
  ]);
  const reply = await generateReply(
    {
      history,
      client: ctx.client,
      products,
      scripts,
      storeName: env.STORE_NAME,
      systemPrompt,
      attachImages: images,
    },
    tenantId,
  );
  if (reply) await dispatchText(ctx, reply);
  else logger.warn('Visão: nenhuma resposta disponível (provedores em falha/cooldown).');
}

/**
 * Transcreve o áudio recebido do cliente usando o provedor de STT configurado.
 * Aceita tanto URL pública (Z-API) quanto base64 (Evolution). Retorna null se
 * a transcrição estiver desativada ou se não houver mídia utilizável.
 */
async function transcribeInboundAudio(
  tenantId: string,
  inbound: NormalizedInbound,
): Promise<string | null> {
  if (!env.hasStt) return null;
  const prompt = await buildTranscriptionPrompt(tenantId);
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
async function buildTranscriptionPrompt(tenantId: string): Promise<string> {
  const base = 'Mensagem de voz de um cliente no WhatsApp, em português do Brasil.';
  try {
    const phrases = await getTriggerPhrases(tenantId);
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
  tenantId: string,
  client: Client,
  history: AiHistoryMessage[],
): Promise<void> {
  // Só vale a pena se houver algum campo faltando.
  const missing = !client.name || !client.company_name || !client.segment || !client.notes;
  if (!missing) return;

  const info = await extractClientInfo(history, tenantId);
  if (!info) return;

  const patch: Record<string, string> = {};
  if (!client.name && info.name) patch.name = info.name;
  if (!client.company_name && info.company_name) patch.company_name = info.company_name;
  if (!client.segment && info.segment) patch.segment = info.segment;
  // notes sempre pode ser atualizado com o interesse mais recente.
  if (info.notes) patch.notes = info.notes;

  if (Object.keys(patch).length === 0) return;
  await updateClient(tenantId, client.id, patch);
  logger.info(`Dados do cliente ${client.id} atualizados via IA`, patch);
}
