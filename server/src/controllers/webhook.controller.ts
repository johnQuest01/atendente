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
  isHumanPaused,
  setHumanPausedUntil,
} from '../db/queries/conversations';
import { listProducts } from '../db/queries/products';
import { listScripts } from '../db/queries/messages_scripts';
import {
  insertMessage,
  markDelivered,
  markRead,
  inboundMessageExists,
  providerMessageExists,
} from '../db/queries/messages';
import { isAgentEnabled, getAiPersona } from '../db/queries/settings';
import { isPhoneBlocked } from '../db/queries/blocked';
import { isReminderOwner } from '../db/queries/reminders';
import { handleOwnerMessage } from '../services/reminders/handler.service';
import { isTenantBlocked } from '../middleware/tenantAccess.middleware';
import { emitNewMessage, emitNewConversation, emitConversationUpdated } from '../socket';
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
/**
 * GET /webhook/whatsapp/:webhookToken — handshake da Meta Cloud.
 *
 * Ao salvar a URL no painel da Meta, ela chama este endpoint com o verify token
 * que o cliente digitou lá. Devolvemos o hub.challenge em texto puro (é isso que
 * a Meta espera) somente se o token bater com o guardado nesta conexão.
 */
export async function verifyWhatsappWebhook(req: Request, res: Response): Promise<void> {
  const webhookToken = req.params.webhookToken as string | undefined;
  const mode = req.query['hub.mode'] as string | undefined;
  const challenge = req.query['hub.challenge'] as string | undefined;
  const verifyToken = req.query['hub.verify_token'] as string | undefined;

  if (mode !== 'subscribe' || !challenge) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Parâmetros de verificação ausentes.' } });
    return;
  }

  const conn = webhookToken ? await getConnectionByWebhookToken(webhookToken) : null;
  if (!conn || !conn.is_active) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conexão de webhook não encontrada.' } });
    return;
  }

  const expected = conn.secrets.verifyToken;
  if (!expected || verifyToken !== expected) {
    logger.warn(`Verificação de webhook recusada para o tenant ${conn.tenant_id}: verify token não confere.`);
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Verify token inválido.' } });
    return;
  }

  logger.info(`Webhook da Meta verificado com sucesso para o tenant ${conn.tenant_id}.`);
  res.status(200).type('text/plain').send(challenge);
}

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
    // Rota legada (sem :webhookToken): tenant padrão + provedor do .env.
    // Em produção: WEBHOOK_VERIFY_TOKEN obrigatório. Prefira /webhook/whatsapp/:webhookToken.
    if (env.isProd && !env.WEBHOOK_VERIFY_TOKEN) {
      logger.warn(
        'Rota legada /webhook/whatsapp recusada: WEBHOOK_VERIFY_TOKEN ausente. Migre para /webhook/whatsapp/:webhookToken.',
      );
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message:
            'Webhook legado sem WEBHOOK_VERIFY_TOKEN. Configure a env ou use /webhook/whatsapp/:webhookToken.',
        },
      });
      return;
    }
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

  // Número bloqueado: ignora totalmente (não salva, não responde, não exibe).
  if (await isPhoneBlocked(tenantId, inbound.phone)) {
    logger.info(`Mensagem de número bloqueado ignorada: ${inbound.phone}`);
    res.status(200).json({ ok: true, ignored: 'blocked' });
    return;
  }

  // Responde rápido ao provedor; processa o resto de forma assíncrona.
  res.status(200).json({ ok: true });

  // fromMe: eco do bot (já temos o id) vs digitação humana no celular.
  if (inbound.fromMe) {
    void runWithTenant(tenantId, () => processFromMe(tenantId, inbound)).catch((err) => {
      logger.error('Erro ao processar mensagem fromMe', err);
    });
    return;
  }

  // Processamento no escopo do tenant resolvido (ativa o RLS — BUG 1).
  void runWithTenant(tenantId, () => processInbound(tenantId, inbound)).catch((err) => {
    logger.error('Erro ao processar mensagem inbound', err);
  });
}

/**
 * Mensagem enviada pelo próprio número (fromMe).
 * - Se o id já está em messages_log (outbound da automação), ignora o eco.
 * - Caso contrário, é operador humano no celular: persiste e pausa a IA
 *   nesta conversa (status waiting) para não atropelar o atendimento.
 */
async function processFromMe(tenantId: string, inbound: NormalizedInbound): Promise<void> {
  if (inbound.providerMessageId && (await providerMessageExists(tenantId, inbound.providerMessageId))) {
    logger.info(`fromMe ignorado (já registrado pela automação): ${inbound.providerMessageId}`);
    return;
  }

  const client = await findOrCreateClient(tenantId, inbound.phone, inbound.senderName);
  const existing = await findOpenConversationByClient(tenantId, client.id);
  const conversation = existing ?? (await findOrCreateOpenConversation(tenantId, client.id));
  if (!existing) emitNewConversation(tenantId, conversation);

  const content =
    inbound.type === 'text'
      ? inbound.text || null
      : inbound.text || `[${inbound.type} enviado pelo operador]`;

  const outboundMsg = await insertMessage(tenantId, {
    conversationId: conversation.id,
    direction: 'outbound',
    type: inbound.type,
    content,
    mediaUrl: inbound.mediaUrl ?? null,
    mediaMime: inbound.mediaMime ?? null,
    zapiMessageId: inbound.providerMessageId,
    origin: 'human',
  });
  emitNewMessage(tenantId, conversation.id, outboundMsg);

  const until = new Date(Date.now() + env.HUMAN_TAKEOVER_MINUTES * 60_000);
  const updated = await setHumanPausedUntil(tenantId, conversation.id, until);
  if (updated) emitConversationUpdated(tenantId, updated);
  logger.info(
    `fromMe humano registrado — IA pausada ${env.HUMAN_TAKEOVER_MINUTES}min na conversa ${conversation.id}`,
  );
}

/**
 * Meta Cloud entrega a mídia como handle, não como URL/base64. Resolve os bytes
 * aqui e preenche `mediaBase64`, para o resto do pipeline (transcrição e
 * re-hospedagem) seguir igual ao da Evolution. Best-effort: falhou, a mensagem
 * é processada sem a mídia.
 */
async function hydrateProviderMedia(tenantId: string, inbound: NormalizedInbound): Promise<void> {
  if (!inbound.mediaId || inbound.mediaBase64 || inbound.mediaUrl) return;
  const wa = await getTenantWhatsapp(tenantId);
  if (!wa.downloadMedia) return;
  const media = await wa.downloadMedia(inbound.mediaId).catch((err) => {
    logger.warn('Falha ao baixar mídia do provedor', err);
    return null;
  });
  if (!media) return;
  inbound.mediaBase64 = media.base64;
  inbound.mediaMime = inbound.mediaMime ?? media.mime;
}

async function processInbound(tenantId: string, inbound: NormalizedInbound): Promise<void> {
  // Idempotência: a Z-API pode reenviar o mesmo webhook (retries). Se já
  // registramos esta mensagem, não processamos de novo (evita resposta
  // automática duplicada e custo desnecessário de IA).
  if (inbound.providerMessageId && (await inboundMessageExists(tenantId, inbound.providerMessageId))) {
    logger.info(`Mensagem duplicada ignorada (já processada): ${inbound.providerMessageId}`);
    return;
  }

  // Assistente pessoal do dono (lembretes). Entra ANTES de findOrCreateClient
  // para o dono não virar cliente nem abrir conversa comercial no painel.
  // Aceita texto ou áudio — o handler transcreve internamente.
  if (
    (inbound.type === 'text' || inbound.type === 'audio') &&
    (await isReminderOwner(tenantId, inbound.phone))
  ) {
    await hydrateProviderMedia(tenantId, inbound);
    const handled = await handleOwnerMessage(tenantId, inbound);
    if (handled) return;
  }

  await hydrateProviderMedia(tenantId, inbound);

  const client = await findOrCreateClient(tenantId, inbound.phone, inbound.senderName);

  const existing = await findOpenConversationByClient(tenantId, client.id);
  const conversation = existing ?? (await findOrCreateOpenConversation(tenantId, client.id));
  if (!existing) emitNewConversation(tenantId, conversation);

  // Flag global + pausa por intervenção humana (janela human_paused_until) +
  // acesso da empresa (teste vencido / conta desativada).
  const agentEnabled = await isAgentEnabled(tenantId);
  const humanTakeover = isHumanPaused(conversation);
  const tenantBlocked = await isTenantBlocked(tenantId);
  const autoReply = agentEnabled && !humanTakeover && !tenantBlocked;

  // Tique azul IMEDIATO: assim que a IA "vê" a mensagem, marcamos como lida —
  // sem esperar transcrição nem geração de resposta. Best-effort, não bloqueia.
  // (Só quando o agente está ligado; desligado, quem "lê" é o humano.)
  if (autoReply && inbound.providerMessageId) {
    const wa = await getTenantWhatsapp(tenantId);
    void wa.markAsRead(inbound.phone, inbound.providerMessageId).catch((err) =>
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
    zapiMessageId: inbound.providerMessageId,
    origin: 'client',
  });
  emitNewMessage(tenantId, conversation.id, inboundMsg);

  // Agente desligado, conversa assumida por humano ou acesso encerrado:
  // registra a mensagem no painel, mas não responde.
  if (!autoReply) {
    logger.info(
      tenantBlocked
        ? 'Empresa sem acesso ativo (teste vencido/desativada) — mensagem registrada, sem resposta automática.'
        : humanTakeover
          ? 'Conversa em waiting (humano) — mensagem registrada, sem resposta automática.'
          : 'Atendente de IA desligado — mensagem registrada, sem resposta automática.',
    );
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
