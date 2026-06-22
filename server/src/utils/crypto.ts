import crypto from 'node:crypto';
import { env } from '../config/env';
import { AppError } from './errors';

/**
 * Criptografia simetrica (AES-256-GCM) para guardar SEGREDOS no banco — em
 * especial as credenciais de WhatsApp de cada empresa (instance id, token,
 * client-token, api key). Nunca guardamos credenciais em texto puro.
 *
 * Formato do texto cifrado: base64(iv).base64(authTag).base64(ciphertext)
 * (o ponto "." nao faz parte do alfabeto base64, entao e um separador seguro).
 */

const ALGO = 'aes-256-gcm';

/**
 * Resolve a chave de 32 bytes a partir de env.ENCRYPTION_KEY. Aceita base64 ou
 * hex que decodifiquem para exatamente 32 bytes; caso contrario, deriva 32
 * bytes deterministicamente via SHA-256 (permite usar uma passphrase qualquer).
 */
function resolveKey(): Buffer {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) {
    throw new AppError(
      'ENCRYPTION_KEY nao configurada — defina-a para cadastrar credenciais com seguranca.',
      500,
      'NO_ENCRYPTION_KEY',
    );
  }
  for (const enc of ['base64', 'hex'] as const) {
    const buf = Buffer.from(raw, enc);
    if (buf.length === 32) return buf;
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

/** Indica se a criptografia esta disponivel (chave configurada). */
export function hasEncryptionKey(): boolean {
  return Boolean(env.ENCRYPTION_KEY);
}

/** Cifra um texto. Retorna a string no formato iv.tag.ciphertext (base64). */
export function encryptSecret(plain: string): string {
  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

/** Decifra um texto cifrado por encryptSecret. Lanca se o formato/tag forem invalidos. */
export function decryptSecret(payload: string): string {
  const key = resolveKey();
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new AppError('Credencial criptografada em formato invalido.', 500, 'BAD_CIPHERTEXT');
  }
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}
