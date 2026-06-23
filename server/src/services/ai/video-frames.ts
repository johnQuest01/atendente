import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '../../config/logger';

/**
 * Extrai alguns QUADROS de um vídeo e devolve como imagens (base64). Assim a IA
 * "entende" o vídeo do cliente usando o mesmo caminho de visão das fotos — e
 * funciona com QUALQUER provedor multimodal (não depende de suporte nativo a
 * vídeo). Best-effort: qualquer falha retorna lista vazia (cai no fallback).
 */

ffmpeg.setFfmpegPath(ffmpegPath.path);

const FETCH_TIMEOUT_MS = 25_000;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024; // 30 MB

export interface VideoFrame {
  base64: string;
  mime: string;
}

/** Baixa o vídeo (URL pública/própria) e extrai até `count` quadros igualmente espaçados. */
export async function extractVideoFrames(url: string, count = 3): Promise<VideoFrame[]> {
  const work = path.join(os.tmpdir(), 'mayra-video', randomUUID());
  const videoPath = path.join(work, 'in.mp4');
  try {
    await fs.mkdir(work, { recursive: true });

    const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) return [];
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_VIDEO_BYTES) return [];
    await fs.writeFile(videoPath, buf);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        // `count` quadros distribuídos ao longo do vídeo, redimensionados (≈640px).
        .screenshots({ count, folder: work, filename: 'frame-%i.jpg', size: '640x?' });
    });

    const files = (await fs.readdir(work))
      .filter((f) => f.startsWith('frame-') && f.endsWith('.jpg'))
      .sort();
    const frames: VideoFrame[] = [];
    for (const f of files) {
      const data = await fs.readFile(path.join(work, f));
      if (data.length > 0) frames.push({ base64: data.toString('base64'), mime: 'image/jpeg' });
    }
    return frames;
  } catch (err) {
    logger.warn('Falha ao extrair quadros do vídeo (visão).', err);
    return [];
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
