import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';
import { persistFile, cleanupTmp, storageMode } from './storage.service';
import {
  createAudio,
  setAudioFileUrl,
  updateAudioFile,
  type CreateAudioInput,
} from '../db/queries/audios';
import { env } from '../config/env';
import type { Audio } from '../types';

ffmpeg.setFfmpegPath(ffmpegPath.path);

interface ConvertResult {
  outputPath: string;
  durationSeconds: number;
}

/** Converte qualquer áudio de entrada para .ogg/opus (formato aceito pelo WhatsApp). */
function convertToOggOpus(inputPath: string): Promise<ConvertResult> {
  // Saída no diretório TEMPORÁRIO DO SO (sempre gravável) — nunca no disco
  // persistente do Render, que pode encher/ficar indisponível.
  const tmpDir = path.join(os.tmpdir(), 'mayra-uploads');
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
interface PreparedAudio {
  /** Bytes do .ogg — só preenchido no modo LOCAL (dev). Em produção (R2) é null. */
  fileData: Buffer | null;
  durationSeconds: number;
  sizeKb: number;
  /** URL pública do arquivo: R2/CDN (produção) ou /uploads (dev). */
  storedUrl: string;
}

/**
 * Converte o arquivo temporário para .ogg/opus e persiste no storage.
 *
 * - PRODUÇÃO (R2): o arquivo vai para o bucket e ganha URL pública permanente.
 *   NÃO guardamos o blob pesado no banco — só a URL.
 * - DEV (local): além de mover para /uploads, lemos os bytes para guardar no
 *   banco, mantendo a rota /media/audios/:id funcionando localmente.
 *
 * Sempre limpa os temporários ao final.
 */
async function prepareAudioFromTmp(tmpFilePath: string): Promise<PreparedAudio> {
  let convertedPath: string | null = null;
  try {
    const { outputPath, durationSeconds } = await convertToOggOpus(tmpFilePath);
    convertedPath = outputPath;

    // No modo local guardamos os bytes no banco (para /media). No remoto, não.
    const fileData = storageMode === 'local' ? await fs.readFile(outputPath) : null;

    const filename = path.basename(outputPath);
    const stored = await persistFile(outputPath, 'audios', filename, 'audio/ogg');

    return { fileData, durationSeconds, sizeKb: stored.sizeKb, storedUrl: stored.url };
  } finally {
    await cleanupTmp(tmpFilePath);
    if (convertedPath) {
      // se persistFile já consumiu o arquivo, unlink falha silenciosamente
      await fs.unlink(convertedPath).catch(() => undefined);
    }
    logger.debug('Processamento de áudio finalizado');
  }
}

/**
 * URL pública final do áudio:
 * - Remoto (R2): a própria URL do CDN (independente do backend).
 * - Local (dev): rota /media servida do banco (precisa do backend no ar).
 */
function publicUrlForAudio(audioId: string, storedUrl: string): string {
  return storageMode === 'remote'
    ? storedUrl
    : `${env.PUBLIC_BASE_URL}/media/audios/${audioId}.ogg`;
}

export async function processAndStoreAudio(input: ProcessAudioInput): Promise<Audio> {
  const prepared = await prepareAudioFromTmp(input.tmpFilePath);

  const dbInput: CreateAudioInput = {
    title: input.title,
    category: input.category,
    tone: input.tone ?? null,
    situation: input.situation ?? null,
    fileUrl: prepared.storedUrl,
    fileSizeKb: prepared.sizeKb,
    durationSeconds: prepared.durationSeconds,
    transcription: input.transcription ?? null,
    keywords: input.keywords ?? [],
    createdBy: input.createdBy ?? null,
    fileData: prepared.fileData,
    mimeType: prepared.fileData ? 'audio/ogg' : null,
  };
  const audio = await createAudio(dbInput);

  const finalUrl = publicUrlForAudio(audio.id, prepared.storedUrl);
  await setAudioFileUrl(audio.id, finalUrl);
  audio.file_url = finalUrl;
  return audio;
}

/**
 * Substitui apenas o arquivo de áudio de um registro existente, mantendo
 * título, categoria, palavras-chave, etc. Retorna null se o áudio não existir.
 */
export async function replaceAudioFile(id: string, tmpFilePath: string): Promise<Audio | null> {
  const prepared = await prepareAudioFromTmp(tmpFilePath);
  const finalUrl = publicUrlForAudio(id, prepared.storedUrl);
  return updateAudioFile(id, {
    fileData: prepared.fileData,
    mimeType: prepared.fileData ? 'audio/ogg' : null,
    fileUrl: finalUrl,
    fileSizeKb: prepared.sizeKb,
    durationSeconds: prepared.durationSeconds,
  });
}
