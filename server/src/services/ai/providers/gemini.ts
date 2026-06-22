import { validateKeyAndModel } from '../model-catalog';
import { classifyHttpError, classifyNetworkError, type AiAdapter, type ChatMessage } from '../types';

/**
 * Adaptador do Google Gemini (Generative Language API). Tem cota gratuita
 * generosa, o que o torna um otimo fallback. A chave vai como `?key=` na URL.
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

function toGeminiContents(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

export const geminiAdapter: AiAdapter = {
  kind: 'gemini',

  async complete(req, creds) {
    const base = (creds.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(creds.model)}:generateContent?key=${encodeURIComponent(creds.apiKey)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: req.system }] },
          contents: toGeminiContents(req.messages),
          generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature },
        }),
        signal: AbortSignal.timeout(30_000),
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
