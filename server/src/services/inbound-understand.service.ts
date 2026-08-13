import { logger } from '../config/logger';
import { complete, hasVisionProvider } from './ai/orchestrator';
import { extractVideoFrames } from './ai/video-frames';
import type { ChatImage } from './ai/types';
import type { NormalizedInbound } from './whatsapp/types';

export async function buildVisualImages(
  inbound: NormalizedInbound,
  persistedUrl?: string | null,
): Promise<ChatImage[]> {
  const source = persistedUrl ?? inbound.mediaUrl ?? null;
  if (inbound.type === 'image') {
    if (source) return [{ url: source, mime: inbound.mediaMime ?? undefined }];
    if (inbound.mediaBase64) {
      return [{ base64: inbound.mediaBase64, mime: inbound.mediaMime ?? 'image/jpeg' }];
    }
    return [];
  }
  if (inbound.type === 'video' && source) {
    const frames = await extractVideoFrames(source).catch(() => []);
    return frames.map((f) => ({ base64: f.base64, mime: f.mime }));
  }
  return [];
}

/**
 * Texto que a secretária usa como "o que o contato mostrou".
 * Sem visão, cai na legenda.
 */
export async function describeInboundVisual(
  tenantId: string,
  inbound: Pick<NormalizedInbound, 'type' | 'mediaUrl' | 'mediaBase64' | 'mediaMime' | 'caption' | 'text'>,
  connectionId?: string | null,
  persistedUrl?: string | null,
): Promise<string | null> {
  if (inbound.type !== 'image' && inbound.type !== 'video') return null;
  const caption = (inbound.caption || inbound.text || '').trim();
  if (!(await hasVisionProvider(tenantId, connectionId))) return caption || null;

  const images = await buildVisualImages(inbound as NormalizedInbound, persistedUrl);
  if (!images.length) return caption || null;

  const kind = inbound.type === 'video' ? 'um vídeo' : 'uma foto';
  try {
    const result = await complete(
      {
        system:
          'Você descreve mídia de WhatsApp para um secretário pessoal. ' +
          'Responda em português do Brasil, 2 a 5 frases, só o que aparece ou se ouve. Sem rodeio.',
        messages: [
          {
            role: 'user',
            content: caption
              ? `O contato mandou ${kind} com a legenda: "${caption}". Descreva o conteúdo.`
              : `O contato mandou ${kind}. Descreva o que se vê, com precisão.`,
            images,
          },
        ],
        maxTokens: 400,
        temperature: 0.2,
      },
      tenantId,
      { connectionId },
    );
    const desc = result?.text?.trim() || null;
    if (desc && caption) return `${caption} — ${desc}`;
    return desc || caption || null;
  } catch (err) {
    logger.warn('Falha ao descrever mídia do contato para a secretária', err);
    return caption || null;
  }
}
