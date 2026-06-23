import { validateKeyAndModel } from '../model-catalog';
import { fetchImageBase64, modelSupportsVision } from '../vision';
import { classifyHttpError, classifyNetworkError, type AiAdapter, type ChatMessage } from '../types';

/**
 * Adaptador do Google Gemini (Generative Language API). Tem cota gratuita
 * generosa, o que o torna um otimo fallback. A chave vai como `?key=` na URL.
 * Modelos multimodais (Gemini 1.5+/2/3) recebem imagens via `inline_data` (base64).
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

async function toGeminiContents(messages: ChatMessage[], vision: boolean) {
  const out: Array<{ role: string; parts: GeminiPart[] }> = [];
  for (const m of messages) {
    const parts: GeminiPart[] = [];
    if (m.content) parts.push({ text: m.content });
    if (vision && m.role === 'user' && m.images?.length) {
      for (const img of m.images) {
        const b = await fetchImageBase64(img);
        if (b) parts.push({ inline_data: { mime_type: b.mime, data: b.base64 } });
      }
    }
    if (parts.length === 0) parts.push({ text: '' });
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

export const geminiAdapter: AiAdapter = {
  kind: 'gemini',

  async complete(req, creds) {
    const base = (creds.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(creds.model)}:generateContent?key=${encodeURIComponent(creds.apiKey)}`;
    const vision = modelSupportsVision('gemini', creds.model);
    const contents = await toGeminiContents(req.messages, vision);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: req.system }] },
          contents,
          generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature },
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw classifyHttpError(res.status, body);
    }
    const data = (await res.json()) as GeminiResponse;
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    return text;
  },

  // Valida a chave E confere se o modelo existe (via catalogo /models).
  validateKey(creds) {
    return validateKeyAndModel('gemini', creds);
  },
};
