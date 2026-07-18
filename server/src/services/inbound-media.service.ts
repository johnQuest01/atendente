import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import net from 'node:net';
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

const MAX_BYTES = 30 * 1024 * 1024; // 30 MB
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

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

function allowlistSuffixes(): string[] {
  const raw = env.MEDIA_FETCH_ALLOWLIST?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\*\./, ''))
    .filter(Boolean);
}

function hostAllowed(hostname: string): boolean {
  const list = allowlistSuffixes();
  if (list.length === 0) return true;
  const host = hostname.toLowerCase();
  return list.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Bloqueia IPs privados/reservados (defesa SSRF). */
function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('::ffff:')) {
      const v4 = normalized.slice('::ffff:'.length);
      if (net.isIPv4(v4)) return isBlockedIp(v4);
    }
    const first = normalized.split(':')[0] || '';
    const n = parseInt(first, 16);
    if (!Number.isNaN(n) && (n & 0xfe00) === 0xfc00) return true;
    if (!Number.isNaN(n) && (n & 0xffc0) === 0xfe80) return true;
    return false;
  }
  return true;
}

async function assertSafeHttpsUrl(raw: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    logger.warn('URL de mídia inbound inválida — download bloqueado.');
    return null;
  }
  if (url.protocol !== 'https:') {
    logger.warn(`URL de mídia inbound rejeitada (esquema ${url.protocol}) — só https.`);
    return null;
  }
  if (url.username || url.password) {
    logger.warn('URL de mídia inbound com credenciais — download bloqueado.');
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'
  ) {
    logger.warn(`URL de mídia inbound com host bloqueado (${host}).`);
    return null;
  }
  if (!hostAllowed(host)) {
    logger.warn(`URL de mídia inbound fora da MEDIA_FETCH_ALLOWLIST (${host}).`);
    return null;
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    logger.warn(`URL de mídia inbound aponta para IP bloqueado (${host}).`);
    return null;
  }
  try {
    const answers = await dns.lookup(host, { all: true, verbatim: true });
    if (answers.length === 0) {
      logger.warn(`DNS sem resposta para host de mídia (${host}).`);
      return null;
    }
    for (const a of answers) {
      if (isBlockedIp(a.address)) {
        logger.warn(`Host de mídia resolve para IP bloqueado (${host} → ${a.address}).`);
        return null;
      }
    }
  } catch (err) {
    logger.warn(`Falha ao resolver host de mídia (${host})`, err);
    return null;
  }
  return url;
}

async function readBodyLimited(
  resp: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!resp.body) {
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;
    return Buffer.from(ab);
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      logger.warn(
        `Mídia recebida excedeu ${Math.round(maxBytes / 1024)} KB durante o download — abortado.`,
      );
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Fetch seguro para URLs de mídia do webhook: https apenas, sem IP privado,
 * redirects revalidados, allowlist opcional, teto de bytes no stream.
 */
export async function safeFetchMedia(
  url: string,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; mime: string | null } | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await assertSafeHttpsUrl(current);
    if (!safe) return null;

    const resp = await fetch(safe.href, {
      signal,
      redirect: 'manual',
      headers: { Accept: '*/*' },
    });

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) {
        logger.warn('Redirect de mídia sem Location — abortado.');
        return null;
      }
      current = new URL(loc, safe.href).href;
      continue;
    }

    if (!resp.ok) {
      logger.warn(`Falha ao baixar mídia recebida (HTTP ${resp.status}).`);
      return null;
    }

    const headerMime = resp.headers.get('content-type');
    const buffer = await readBodyLimited(resp, MAX_BYTES);
    if (!buffer) return null;
    return { buffer, mime: headerMime };
  }
  logger.warn('Mídia inbound: muitos redirects — abortado.');
  return null;
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
    const buffer = Buffer.from(clean, 'base64');
    if (buffer.length > MAX_BYTES) {
      logger.warn(
        `Mídia base64 muito grande (${Math.round(buffer.length / 1024)} KB) — não re-hospedada.`,
      );
      return null;
    }
    return { buffer, mime: input.mime ?? null };
  }
  if (!input.url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const fetched = await safeFetchMedia(input.url, controller.signal);
    if (!fetched) return null;
    return { buffer: fetched.buffer, mime: input.mime ?? fetched.mime };
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

  if (storageMode === 'remote') {
    const tmpDir = path.join(os.tmpdir(), 'mayra-inbound');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${randomUUID()}.${ext}`);
    await fs.writeFile(tmpPath, buffer);
    const stored = await persistFile(tmpPath, `inbound/${kind}`, path.basename(tmpPath), mime);
    return { url: stored.url, mime };
  }

  const id = await insertMediaFile(tenantId, {
    kind,
    mime,
    data: buffer,
    sizeKb: Math.round(buffer.length / 1024),
  });
  const token = signMediaToken(tenantId, id);
  return { url: `${env.PUBLIC_BASE_URL}/media/files/${id}?t=${token}`, mime };
}
