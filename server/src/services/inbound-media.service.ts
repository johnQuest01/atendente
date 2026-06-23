import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { persistFile, storageMode } from './storage.service';
import { insertMediaFile } from '../db/queries/media_files';
import { signMediaToken } from '../utils/media-token';
import type { MessageType } from '../types';

/**
 * Re-hospedagem de mídia RECEBIDA do cliente (imagem/vídeo/áudio/documento).
 *
 * A URL que a Z-API entrega expira em ~30 dias e o base64 da Evolution é
 * volátil. Para que a mídia apareça/toque no painel para sempre, baixamos os
 * bytes e guardamos numa URL pública ESTÁVEL:
 *  - PRODUÇÃO: Cloudflare R2 (CDN permanente, suporta vídeo grande/range).
 *  - DEV/local: tabela media_files (Neon) servida por /media/files/:id?t=token.
 *
 * Nunca derruba o fluxo: se algo falhar, retorna null e a mensagem é salva sem
 * a mídia (o texto/transcrição/legenda continua).
 */

// Guarda de tamanho: evita estourar memória/banco com arquivos gigantes.
const MAX_BYTES = 30 * 1024 * 1024; // 30 MB
const DOWNLOAD_TIMEOUT_MS = 20_000;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
};

function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
}

function extFor(mime: string): string {
  return MIME_EXT[mime] ?? 'bin';
}

function kindFor(type: MessageType): string {
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  if (type === 'audio') return 'audio';
  return 'document';
}

export interface PersistInboundMediaInput {
  type: MessageType;
  url?: string | null;
  base64?: string | null;
  mime?: string | null;
}

export interface PersistedInboundMedia {
  url: string;
  mime: string;
}

async function downloadBytes(
  input: PersistInboundMediaInput,
): Promise<{ buffer: Buffer; mime: string | null } | null> {
  if (input.base64) {
    const clean = input.base64.replace(/^data:[^;]+;base64,/, '');
    return { buffer: Buffer.from(clean, 'base64'), mime: input.mime ?? null };
  }
  if (!input.url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(input.url, { signal: controller.signal });
    if (!resp.ok) {
      logger.warn(`Falha ao baixar mídia recebida (HTTP ${resp.status}).`);
      return null;
    }
    const headerMime = resp.headers.get('content-type');
    const ab = await resp.arrayBuffer();
    return { buffer: Buffer.from(ab), mime: input.mime ?? headerMime };
  } finally {
    clearTimeout(timer);
  }
}

export async function persistInboundMedia(
  tenantId: string,
  input: PersistInboundMediaInput,
): Promise<PersistedInboundMedia | null> {
  let downloaded: { buffer: Buffer; mime: string | null } | null;
  try {
    downloaded = await downloadBytes(input);
  } catch (err) {
    logger.warn('Erro ao obter os bytes da mídia recebida', err);
    return null;
  }

  if (!downloaded || downloaded.buffer.length === 0) return null;
  const { buffer } = downloaded;
  if (buffer.length > MAX_BYTES) {
    logger.warn(`Mídia recebida muito grande (${Math.round(buffer.length / 1024)} KB) — não re-hospedada.`);
    return null;
  }

  const mime = normalizeMime(downloaded.mime);
  const ext = extFor(mime);
  const kind = kindFor(input.type);

  // Produção (R2): grava arquivo permanente no bucket via arquivo temporário.
  if (storageMode === 'remote') {
    const tmpDir = path.join(os.tmpdir(), 'mayra-inbound');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${randomUUID()}.${ext}`);
    await fs.writeFile(tmpPath, buffer);
    const stored = await persistFile(tmpPath, `inbound/${kind}`, path.basename(tmpPath), mime);
    return { url: stored.url, mime };
  }

  // Dev/local: guarda no banco e serve por /media/files/:id (com token assinado).
  const id = await insertMediaFile(tenantId, {
    kind,
    mime,
    data: buffer,
    sizeKb: Math.round(buffer.length / 1024),
  });
  const token = signMediaToken(tenantId, id);
  return { url: `${env.PUBLIC_BASE_URL}/media/files/${id}?t=${token}`, mime };
}
