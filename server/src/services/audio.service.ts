import path from 'node:path';
import fs from 'node:fs/promises';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';
import { persistFile, cleanupTmp } from './storage.service';
import { createAudio, setAudioFileUrl, type CreateAudioInput } from '../db/queries/audios';
import type { Audio } from '../types';

ffmpeg.setFfmpegPath(ffmpegPath.path);

interface ConvertResult {
  outputPath: string;
  durationSeconds: number;
}

/** Converte qualquer áudio de entrada para .ogg/opus (formato aceito pelo WhatsApp). */
function convertToOggOpus(inputPath: string): Promise<ConvertResult> {
  const tmpDir = path.join(env.uploadDirAbsolute, 'tmp');
  const outputPath = path.join(tmpDir, `${path.basename(inputPath, path.extname(inputPath))}.ogg`);

  return new Promise<ConvertResult>((resolve, reject) => {
    let duration = 0;
    ffmpeg(inputPath)
      .audioCodec('libopus')
      .audioBitrate('64k')
      .audioChannels(1)
      .format('ogg')
      .on('codecData', (data: { duration?: string }) => {
        if (data.duration) duration = parseDuration(data.duration);
      })
      .on('error', (err: Error) => {
        reject(new AppError(`Falha ao converter áudio: ${err.message}`, 500, 'AUDIO_CONVERSION_FAILED'));
      })
      .on('end', () => resolve({ outputPath, durationSeconds: Math.round(duration) }))
      .save(outputPath);
  });
}

function parseDuration(value: string): number {
  const [h, m, s] = value.split(':').map((p) => parseFloat(p));
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

interface ProcessAudioInput {
  tmpFilePath: string;
  title: string;
  category: string;
  tone?: string | null;
  situation?: string | null;
  transcription?: string | null;
  keywords?: string[];
  createdBy?: string | null;
}

/**
 * Pipeline completo de upload de áudio:
 * 1. Converte para .ogg/opus
 * 2. Persiste no storage
 * 3. Salva o registro no banco
 */
export async function processAndStoreAudio(input: ProcessAudioInput): Promise<Audio> {
  let convertedPath: string | null = null;
  try {
    const { outputPath, durationSeconds } = await convertToOggOpus(input.tmpFilePath);
    convertedPath = outputPath;

    // Lê os bytes do .ogg ANTES de mover o arquivo: guardamos o conteúdo no
    // banco (Neon) para que o áudio seja sempre acessível pela Z-API, mesmo
    // que o disco do servidor seja efêmero ou o host público mude.
    const fileData = await fs.readFile(outputPath);

    const filename = path.basename(outputPath);
    const stored = await persistFile(outputPath, 'audios', filename);

    const dbInput: CreateAudioInput = {
      title: input.title,
      category: input.category,
      tone: input.tone ?? null,
      situation: input.situation ?? null,
      fileUrl: stored.url,
      fileSizeKb: stored.sizeKb,
      durationSeconds,
      transcription: input.transcription ?? null,
      keywords: input.keywords ?? [],
      createdBy: input.createdBy ?? null,
      fileData,
      mimeType: 'audio/ogg',
    };
    const audio = await createAudio(dbInput);

    // URL pública estável servida pelo próprio backend a partir do banco.
    // Isso garante que tanto o painel quanto a Z-API consigam tocar o áudio.
    const mediaUrl = `${env.PUBLIC_BASE_URL}/media/audios/${audio.id}.ogg`;
    await setAudioFileUrl(audio.id, mediaUrl);
    audio.file_url = mediaUrl;
    return audio;
  } finally {
    await cleanupTmp(input.tmpFilePath);
    if (convertedPath) {
      // se persistFile já moveu o arquivo, unlink falha silenciosamente
      await fs.unlink(convertedPath).catch(() => undefined);
    }
    logger.debug('Processamento de áudio finalizado');
  }
}
