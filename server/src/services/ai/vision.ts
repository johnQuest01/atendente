import type { AiKind, ChatImage } from './types';

/**
 * Utilidades de VISÃO (multimodal): detectar se um modelo "enxerga" imagens e
 * preparar a imagem no formato que cada provedor aceita.
 *
 * Estratégia de entrega da imagem:
 *   - OpenAI/compatíveis: URL pública direta (image_url) quando acessível ao
 *     provedor; senão, data URL base64.
 *   - Anthropic/Gemini: sempre base64 (o nosso backend baixa a imagem) — assim
 *     funciona tanto em produção (R2) quanto em dev (URL local).
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB — protege contra payloads gigantes.

/** URL acessível por um provedor EXTERNO? (https público, sem localhost/IP privado.) */
export function isPublicHttpUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false; // provedores externos exigem https
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return false;
  }
  return true;
}

/** Baixa a imagem (ou usa o base64 já informado) e devolve base64 + mime. */
export async function fetchImageBase64(img: ChatImage): Promise<{ base64: string; mime: string } | null> {
  if (img.base64) return { base64: img.base64, mime: img.mime ?? 'image/jpeg' };
  if (!img.url) return null;
  try {
    const resp = await fetch(img.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) return null;
    const mime = (img.mime ?? resp.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    return { base64: buf.toString('base64'), mime };
  } catch {
    return null;
  }
}

/** Constrói uma data URL (base64) a partir de uma imagem — para o formato OpenAI. */
export async function toDataUrl(img: ChatImage): Promise<string | null> {
  const b = await fetchImageBase64(img);
  return b ? `data:${b.mime};base64,${b.base64}` : null;
}

/** Normaliza o mime para os tipos aceitos pela Anthropic. */
export function anthropicMediaType(mime: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const m = (mime || '').toLowerCase();
  if (m.includes('png')) return 'image/png';
  if (m.includes('gif')) return 'image/gif';
  if (m.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

/**
 * O modelo "enxerga" imagens? Heurística por nome (sem chamada de rede), o que
 * permite decidir na hora — e funciona com o failover: um provedor sem visão na
 * cadeia simplesmente ignora a imagem e responde só com o texto/legenda.
 */
export function modelSupportsVision(kind: AiKind, model: string, _baseUrl?: string | null): boolean {
  const m = (model || '').toLowerCase();
  if (!m) return false;

  if (kind === 'anthropic') {
    // Claude 3+ (e toda a linha 4/Fable) são multimodais; só os legados não.
    if (m.includes('claude-2') || m.includes('instant')) return false;
    return m.startsWith('claude-');
  }

  if (kind === 'gemini') {
    // Gemini 1.5+ e as linhas 2/3 são multimodais; o 1.0 "gemini-pro" (texto) não.
    if (m === 'gemini-pro' || m.startsWith('gemini-1.0')) return false;
    return m.startsWith('gemini') || m.startsWith('gemma-3') || m.startsWith('learnlm') || m.includes('vision');
  }

  // openai-compatível (OpenAI, Groq, OpenRouter, custom): decide pelo nome do modelo.
  if (/(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|chatgpt-4o)/.test(m)) return true; // família OpenAI multimodal
  if (/^o[1-9]/.test(m)) return true; // o1/o3/o4...
  // Modelos abertos com visão (Groq/OpenRouter/locais):
  if (
    /(vision|llava|pixtral|llama-?3\.2|llama-?4|qwen.*vl|qwen2-vl|gemini|claude-3|moondream|internvl|minicpm-v|phi-3.*vision|phi-4.*vision|grok.*vision)/.test(
      m,
    )
  ) {
    return true;
  }
  return false;
}
