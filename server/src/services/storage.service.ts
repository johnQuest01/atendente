import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Storage de arquivos. Em dev usa o disco local (env.uploadDirAbsolute) e
 * gera URLs públicas servidas pelo Express em /uploads.
 *
 * Em produção, este módulo é o ponto único para trocar por S3/R2 — basta
 * implementar `save` enviando ao bucket e retornando a URL pública.
 */

export interface StoredFile {
  url: string;
  relativePath: string;
  sizeKb: number;
}

const usingS3 = Boolean(env.S3_BUCKET && env.S3_ENDPOINT && env.S3_ACCESS_KEY);

/** Move um arquivo temporário para o destino final e retorna sua URL pública. */
export async function persistFile(
  tmpPath: string,
  destSubdir: string,
  filename: string,
): Promise<StoredFile> {
  if (usingS3) {
    logger.warn('S3 configurado, mas o upload S3 ainda não foi implementado; usando disco local como fallback.');
  }

  const destDir = path.join(env.uploadDirAbsolute, destSubdir);
  await fs.mkdir(destDir, { recursive: true });

  const destPath = path.join(destDir, filename);
  await fs.rename(tmpPath, destPath).catch(async () => {
    // rename pode falhar entre volumes; faz copy+unlink como fallback
    await fs.copyFile(tmpPath, destPath);
    await fs.unlink(tmpPath).catch(() => undefined);
  });

  const stats = await fs.stat(destPath);
  const relativePath = path.posix.join(destSubdir, filename);

  return {
    url: `${env.PUBLIC_BASE_URL}/uploads/${relativePath}`,
    relativePath,
    sizeKb: Math.round(stats.size / 1024),
  };
}

/** Remove um arquivo temporário, ignorando erros. */
export async function cleanupTmp(tmpPath: string): Promise<void> {
  await fs.unlink(tmpPath).catch(() => undefined);
}
