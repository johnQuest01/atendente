import { validateKeyAndModel } from '../model-catalog';
import { classifyHttpError, classifyNetworkError, type AiAdapter, type ChatMessage } from '../types';

/**
 * Adaptador "OpenAI Chat Completions". Cobre OpenAI/ChatGPT e qualquer API
 * compativel apenas trocando a `baseUrl`/`model`:
 *   - OpenAI:     https://api.openai.com/v1            (gpt-4o-mini, ...)
 *   - Groq:       https://api.groq.com/openai/v1       (llama-3.3-70b-versatile, ...) — cota gratis
 *   - OpenRouter: https://openrouter.ai/api/v1         (modelos ":free", ...)
 *   - Local:      http://host:porta/v1                 (Ollama/LM Studio/...)
 */

const DEFAULT_BASE = 'https://api.openai.com/v1';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function toOpenAiMessages(system: string, messages: ChatMessage[]) {
  return [{ role: 'system' as const, content: system }, ...messages];
}

export const openaiAdapter: AiAdapter = {
  kind: 'openai',

  async complete(req, creds) {
    const base = (creds.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creds.apiKey}`,
        },
        body: JSON.stringify({
          model: creds.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          messages: toOpenAiMessages(req.system, req.messages),
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
    const data = (await res.json()) as ChatCompletionResponse;
    return (data.choices?.[0]?.message?.content ?? '').trim();
  },

  // Valida a chave E confere se o modelo existe (via catalogo /models).
  validateKey(creds) {
    return validateKeyAndModel('openai', creds);
  },
};
