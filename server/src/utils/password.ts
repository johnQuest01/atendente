import crypto from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';

/**
 * Hashing de SENHAS resistente a ataque de força bruta com GPU/ASIC.
 *
 * Usamos **scrypt** (RFC 7914), embutido no Node — não exige dependência
 * nativa extra (mais confiável no build do Render). scrypt é *memory-hard*:
 * exige MUITA memória por tentativa, o que neutraliza a vantagem de placas de
 * vídeo/ASICs (diferente de bcrypt/SHA, que escalam bem em GPU). Com os
 * parâmetros abaixo, cada tentativa custa ~32 MB e dezenas de ms — tornando a
 * quebra de uma senha forte inviável (anos), independentemente do hardware.
 *
 * Formato persistido: `scrypt$N$r$p$saltB64$hashB64`.
 * Hashes antigos em bcrypt ($2a/$2b/$2y) continuam sendo verificados e são
 * convertidos para scrypt no próximo login (rehash transparente).
 */

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// Custo: N=2^15 (32768), r=8, p=1 → ~32 MB por tentativa. maxmem precisa ser
// > 128*N*r (~33.5 MB), por isso 64 MB.
const N = 32_768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

const SCRYPT_PREFIX = 'scrypt$';
const BCRYPT_RE = /^\$2[aby]\$/;

/** Gera o hash forte (scrypt) de uma senha em texto puro. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(plain.normalize('NFKC'), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return `${SCRYPT_PREFIX}${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verifica uma senha contra o hash salvo (aceita scrypt novo e bcrypt legado). */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (stored.startsWith(SCRYPT_PREFIX)) {
    const parts = stored.split('$');
    // ['scrypt', N, r, p, salt, hash]
    if (parts.length !== 6) return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!n || !r || !p || salt.length === 0 || expected.length === 0) return false;
    const derived = await scryptAsync(plain.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
    // Comparação em tempo constante (evita timing attack).
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  }

  if (BCRYPT_RE.test(stored)) {
    return bcrypt.compare(plain, stored);
  }

  return false;
}

/** True quando o hash NÃO está no formato forte (scrypt) — deve ser regerado. */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith(SCRYPT_PREFIX);
}
