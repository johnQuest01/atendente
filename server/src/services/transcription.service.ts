import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Serviço de transcrição de áudio (speech-to-text).
 *
 * Usa um endpoint compatível com a API da OpenAI (`/audio/transcriptions`),
 * o que permite usar tanto a OpenAI quanto a Groq (Whisper large v3, com cota
 * gratuita) apenas trocando STT_BASE_URL / STT_MODEL / STT_API_KEY no .env.
 *
 * Se a transcrição não estiver configurada (STT_PROVIDER=none ou sem chave),
 * todas as funções retornam null e o chamador deve degradar com elegância.
 */

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — limite típico das APIs Whisper

async function transcribeBuffer(
  buffer: ArrayBuffer,
  filename: string,
  prompt?: string,
): Promise<string | null> {
  if (!env.hasStt) return null;
  if (buffer.byteLength === 0) return null;
  if (buffer.byteLength > MAX_BYTES) {
    logger.warn(`Áudio acima do limite de transcrição (${Math.round(buffer.byteLength / 1024)} KB).`);
    return null;
  }

  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', env.STT_MODEL);
  if (env.STT_LANGUAGE) form.append('language', env.STT_LANGUAGE);
  // temperature 0 reduz "alucinações" do Whisper em áudios curtos/ruidosos.
  form.append('temperature', '0');
  // O prompt dá contexto e enviesa o modelo para as frases esperadas, o que
  // melhora muito a precisão em áudios curtos (ex.: "não entendi").
  if (prompt) form.append('prompt', prompt.slice(0, 800));
  // Mantém a resposta simples (texto puro no campo "text").
  form.append('response_format', 'json');

  const res = await fetch(`${env.STT_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STT_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`STT ${res.status}: ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as { text?: string };
  const text = json.text?.trim();
  return text && text.length > 0 ? text : null;
}

/** Baixa um áudio de uma URL pública e transcreve. */
export async function transcribeAudioFromUrl(url: string, prompt?: string): Promise<string | null> {
  if (!env.hasStt) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Falha ao baixar áudio: HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const filename = guessFilename(url);
    return await transcribeBuffer(buffer, filename, prompt);
  } catch (err) {
    logger.warn('Falha ao transcrever áudio (URL)', err);
    return null;
  }
}

/** Transcreve um áudio recebido em base64 (ex.: Evolution API com base64 ativo). */
export async function transcribeAudioFromBase64(
  base64: string,
  prompt?: string,
  filename = 'audio.ogg',
): Promise<string | null> {
  if (!env.hasStt) return null;
  try {
    const clean = base64.includes(',') ? base64.split(',')[1] : base64;
    const buffer = Buffer.from(clean, 'base64');
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return await transcribeBuffer(arrayBuffer, filename, prompt);
  } catch (err) {
    logger.warn('Falha ao transcrever áudio (base64)', err);
    return null;
  }
}

function guessFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').pop();
    if (base && /\.(ogg|mp3|m4a|wav|webm|opus|mp4)$/i.test(base)) return base;
  } catch {
    /* ignore */
  }
  return 'audio.ogg';
}
