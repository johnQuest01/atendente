import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';

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

/**
 * Quais variáveis faltam para o modo remoto. Existe porque a configuração é
 * tudo-ou-nada: com uma só faltando o sistema cai no disco local calado, e de
 * fora parece que o R2 está ligado quando não está.
 */
export function missingStorageVars(): string[] {
  const missing: string[] = [];
  if (!env.s3Endpoint) missing.push('R2_ACCOUNT_ID (ou S3_ENDPOINT)');
  if (!env.S3_BUCKET) missing.push('S3_BUCKET');
  if (!env.S3_ACCESS_KEY) missing.push('S3_ACCESS_KEY');
  if (!env.S3_SECRET_KEY) missing.push('S3_SECRET_KEY');
  if (!env.S3_PUBLIC_URL) missing.push('S3_PUBLIC_URL');
  return missing;
}

/** Loga, uma vez no boot, qual modo de storage está ativo. */
export function logStorageMode(): void {
  if (storageMode === 'remote') {
    logger.info(`Storage remoto ATIVO (S3/R2) — bucket="${env.S3_BUCKET}", público="${env.s3PublicUrl}".`);
    return;
  }
  const missing = missingStorageVars();
  // Nenhuma preenchida = escolha (dev). Algumas preenchidas = engano.
  if (missing.length === 5) {
    logger.warn('Storage LOCAL (disco/dev) — defina S3_* / R2_ACCOUNT_ID para URLs públicas permanentes.');
  } else {
    logger.error(
      `Storage LOCAL por CONFIGURAÇÃO INCOMPLETA do R2. Faltando: ${missing.join(', ')}. ` +
        'Enquanto isso, a mídia fica no disco do servidor e some se o disco não for persistente.',
    );
  }
}

/**
 * Traduz o erro do SDK da AWS para algo que aponte a variável culpada. Os
 * códigos vêm do próprio S3/R2; sem isso o usuário só vê "SignatureDoesNotMatch".
 */
export function describeS3Error(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  const code = (err as { Code?: string })?.Code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  const kind = name || code;

  if (kind.includes('InvalidAccessKeyId')) {
    return 'S3_ACCESS_KEY inválida (o R2 não reconhece esta chave).';
  }
  if (kind.includes('SignatureDoesNotMatch')) {
    return 'S3_SECRET_KEY não confere com a S3_ACCESS_KEY.';
  }
  if (kind.includes('NoSuchBucket')) {
    return `Bucket "${env.S3_BUCKET}" não existe nesta conta — confira S3_BUCKET.`;
  }
  if (kind.includes('AccessDenied')) {
    return 'Credencial sem permissão de escrita no bucket (o token do R2 precisa ser de leitura E escrita).';
  }
  if (message.includes('ENOTFOUND') || message.includes('getaddrinfo') || kind.includes('EAI_AGAIN')) {
    return `Endpoint inacessível (${env.s3Endpoint}) — confira R2_ACCOUNT_ID.`;
  }
  if (kind.includes('TimeoutError') || message.toLowerCase().includes('timeout')) {
    return 'Tempo esgotado ao falar com o R2.';
  }
  return message;
}

/**
 * Escreve e apaga um objeto minúsculo, provando credencial, bucket e permissão
 * de escrita. Checar só se as variáveis existem não pega chave errada.
 */
export async function testRemoteStorage(): Promise<{ ok: boolean; detail: string }> {
  if (storageMode !== 'remote') {
    return { ok: false, detail: 'Storage remoto não configurado.' };
  }
  const key = `.healthcheck/${Date.now()}.txt`;
  try {
    await getS3().send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: 'ok',
        ContentType: 'text/plain',
      }),
    );
  } catch (err) {
    return { ok: false, detail: describeS3Error(err) };
  }

  // Gravar não basta: se o bucket não for público, o áudio sobe mas o WhatsApp
  // recebe uma URL que responde 404. É a falha mais confusa do R2, porque nada
  // no envio dá erro.
  let publicOk = false;
  let publicDetail = '';
  try {
    const res = await fetch(`${env.s3PublicUrl}/${key}`, { signal: AbortSignal.timeout(6000) });
    publicOk = res.ok;
    if (!publicOk) {
      publicDetail =
        res.status === 404 || res.status === 403
          ? 'a URL pública não serve o arquivo — ative o "Public Development URL" no bucket ou confira S3_PUBLIC_URL.'
          : `a URL pública respondeu HTTP ${res.status}.`;
    }
  } catch (err) {
    publicDetail = `a URL pública não respondeu (${err instanceof Error ? err.message : 'erro'}).`;
  }

  await getS3()
    .send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
    .catch(() => undefined);

  return publicOk
    ? { ok: true, detail: `Bucket "${env.S3_BUCKET}": escrita e leitura pública OK.` }
    : { ok: false, detail: `Escrita OK, mas ${publicDetail}` };
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
    try {
      await getS3().send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: relativePath,
          Body: body,
          ContentType: contentType ?? guessContentType(filename),
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } catch (err) {
      const detail = describeS3Error(err);
      logger.error(`Falha ao enviar "${relativePath}" para o R2: ${detail}`);
      throw new AppError(`Não foi possível salvar no R2: ${detail}`, 502, 'STORAGE_ERROR');
    }
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
