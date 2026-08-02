import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';
import { persistFile, cleanupTmp, storageMode } from './storage.service';
import { signMediaToken } from '../utils/media-token';
import {
  createAudio,
  setAudioFileUrl,
  updateAudioFile,
  type CreateAudioInput,
} from '../db/queries/audios';
import { env } from '../config/env';
import type { Audio } from '../types';

// Binário do ffmpeg embarcado pelo @ffmpeg-installer. Se, por qualquer motivo,
// o pacote da plataforma não tiver sido instalado (ex.: build com
// --omit=optional), o caminho vem vazio — avisamos no boot para que a falha de
// conversão de áudio não vire um "erro interno" misterioso mais tarde.
if (ffmpegPath?.path) {
  ffmpeg.setFfmpegPath(ffmpegPath.path);
} else {
  logger.error(
    'ffmpeg não encontrado (@ffmpeg-installer). A conversão de áudio vai falhar — ' +
      'reinstale as dependências sem --omit=optional ou disponibilize o ffmpeg no PATH.',
  );
}

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
  tenantId: string;
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
    let stored;
    try {
      stored = await persistFile(outputPath, 'audios', filename, 'audio/ogg');
    } catch (err) {
      // Erro cru de storage (S3/R2) ou de disco: em produção o middleware o
      // mascara como "Erro interno do servidor". Convertemos numa mensagem
      // acionável (e logamos a causa real) para o operador saber o que corrigir.
      logger.error('Falha ao persistir o áudio no storage', err);
      throw new AppError(
        storageMode === 'remote'
          ? 'Não foi possível enviar o áudio para o armazenamento (R2/S3). Verifique as credenciais S3_ACCESS_KEY/S3_SECRET_KEY, o S3_BUCKET e o R2_ACCOUNT_ID/S3_ENDPOINT.'
          : 'Não foi possível salvar o áudio no disco do servidor. Verifique o UPLOAD_DIR e o disco persistente do Render (ou configure o R2 para URLs permanentes).',
        500,
        'AUDIO_STORAGE_FAILED',
      );
    }

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
 *   Acompanha token assinado que escopa a mídia por empresa (BUG 2).
 */
function publicUrlForAudio(tenantId: string, audioId: string, storedUrl: string): string {
  if (storageMode === 'remote') return storedUrl;
  const token = signMediaToken(tenantId, audioId);
  return `${env.PUBLIC_BASE_URL}/media/audios/${audioId}.ogg?t=${token}`;
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
  let audio: Audio;
  try {
    audio = await createAudio(input.tenantId, dbInput);
    const finalUrl = publicUrlForAudio(input.tenantId, audio.id, prepared.storedUrl);
    await setAudioFileUrl(input.tenantId, audio.id, finalUrl);
    audio.file_url = finalUrl;
  } catch (err) {
    // Erro cru do banco (ex.: coluna ausente por migration não aplicada, blob
    // recusado): logamos a causa e devolvemos uma mensagem clara em vez do
    // "Erro interno do servidor" genérico.
    logger.error('Falha ao registrar o áudio no banco de dados', err);
    throw new AppError(
      'Não foi possível registrar o áudio no banco de dados. Verifique se as migrations foram aplicadas (npm run migrate) e a conexão com o banco.',
      500,
      'AUDIO_DB_FAILED',
    );
  }
  return audio;
}

/**
 * Substitui apenas o arquivo de áudio de um registro existente, mantendo
 * título, categoria, palavras-chave, etc. Retorna null se o áudio não existir.
 */
export async function replaceAudioFile(
  tenantId: string,
  id: string,
  tmpFilePath: string,
): Promise<Audio | null> {
  const prepared = await prepareAudioFromTmp(tmpFilePath);
  const finalUrl = publicUrlForAudio(tenantId, id, prepared.storedUrl);
  try {
    return await updateAudioFile(tenantId, id, {
      fileData: prepared.fileData,
      mimeType: prepared.fileData ? 'audio/ogg' : null,
      fileUrl: finalUrl,
      fileSizeKb: prepared.sizeKb,
      durationSeconds: prepared.durationSeconds,
    });
  } catch (err) {
    logger.error('Falha ao substituir o arquivo de áudio no banco de dados', err);
    throw new AppError(
      'Não foi possível atualizar o áudio no banco de dados. Verifique se as migrations foram aplicadas (npm run migrate) e a conexão com o banco.',
      500,
      'AUDIO_DB_FAILED',
    );
  }
}
