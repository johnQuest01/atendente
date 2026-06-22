import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Storage de arquivos (áudios e imagens).
 *
 * - PRODUÇÃO (recomendado): Cloudflare R2 / qualquer storage compatível com S3.
 *   O arquivo ganha uma URL pública PERMANENTE (CDN) — `env.s3PublicUrl` — que a
 *   Z-API consegue baixar a qualquer momento, mesmo que o backend esteja
 *   reiniciando. A disponibilidade da mídia NÃO depende do backend estar no ar.
 *
 * - DESENVOLVIMENTO / fallback: disco local (`env.uploadDirAbsolute`), servido
 *   pelo Express em `/uploads`. Ativado automaticamente quando o R2 não está
 *   configurado.
 *
 * A detecção é automática (`env.hasRemoteStorage`). Este módulo é o ponto único
 * de armazenamento — o resto do sistema só conhece a URL pública retornada.
 */

export type StorageMode = 'remote' | 'local';

export const storageMode: StorageMode = env.hasRemoteStorage ? 'remote' : 'local';

export interface StoredFile {
  url: string;
  relativePath: string;
  sizeKb: number;
}

// Cliente S3 criado sob demanda (apenas no modo remoto).
let s3: S3Client | null = null;
function getS3(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: env.S3_REGION,
      endpoint: env.s3Endpoint,
      // R2/S3 fora da AWS exigem path-style desligado; o SDK v3 resolve bem
      // com forcePathStyle=false (virtual-host), padrão do R2 com domínio público.
      forcePathStyle: false,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY as string,
        secretAccessKey: env.S3_SECRET_KEY as string,
      },
    });
  }
  return s3;
}

/** Loga, uma vez no boot, qual modo de storage está ativo. */
export function logStorageMode(): void {
  if (storageMode === 'remote') {
    logger.info(`Storage remoto ATIVO (S3/R2) — bucket="${env.S3_BUCKET}", público="${env.s3PublicUrl}".`);
  } else {
    logger.warn('Storage LOCAL (disco/dev) — defina S3_* / R2_ACCOUNT_ID para URLs públicas permanentes.');
  }
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Sobe um arquivo (já existente em `tmpPath`) para o storage e retorna sua URL
 * pública. No modo remoto, envia ao bucket; no local, move para o diretório de
 * uploads. Em ambos os casos o arquivo temporário é consumido.
 */
export async function persistFile(
  tmpPath: string,
  destSubdir: string,
  filename: string,
  contentType?: string,
): Promise<StoredFile> {
  const relativePath = path.posix.join(destSubdir, filename);

  if (storageMode === 'remote') {
    const body = await fs.readFile(tmpPath);
    await getS3().send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: relativePath,
        Body: body,
        ContentType: contentType ?? guessContentType(filename),
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    // tmp é responsabilidade do chamador limpar; aqui só liberamos esta cópia.
    await fs.unlink(tmpPath).catch(() => undefined);

    return {
      url: `${env.s3PublicUrl}/${relativePath}`,
      relativePath,
      sizeKb: Math.round(body.length / 1024),
    };
  }

  // ----- Fallback local (dev) -----
  const destDir = path.join(env.uploadDirAbsolute, destSubdir);
  await fs.mkdir(destDir, { recursive: true });

  const destPath = path.join(destDir, filename);
  await fs.rename(tmpPath, destPath).catch(async () => {
    // rename pode falhar entre volumes; faz copy+unlink como fallback
    await fs.copyFile(tmpPath, destPath);
    await fs.unlink(tmpPath).catch(() => undefined);
  });

  const stats = await fs.stat(destPath);
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
