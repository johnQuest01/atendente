import { validateKeyAndModel } from '../model-catalog';
import { isPublicHttpUrl, modelSupportsVision, toDataUrl } from '../vision';
import { classifyHttpError, classifyNetworkError, type AiAdapter, type ChatMessage } from '../types';

/**
 * Adaptador "OpenAI Chat Completions". Cobre OpenAI/ChatGPT e qualquer API
 * compativel apenas trocando a `baseUrl`/`model`:
 *   - OpenAI:     https://api.openai.com/v1            (gpt-4o-mini, ...)
 *   - Groq:       https://api.groq.com/openai/v1       (llama-3.3-70b-versatile, ...) — cota gratis
 *   - OpenRouter: https://openrouter.ai/api/v1         (modelos ":free", ...)
 *   - Local:      http://host:porta/v1                 (Ollama/LM Studio/...)
 *
 * Com VISÃO: modelos multimodais (gpt-4o/4.1/5, llava, pixtral, ...) recebem as
 * imagens via partes `image_url`. Modelos sem visão recebem só o texto.
 */

const DEFAULT_BASE = 'https://api.openai.com/v1';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

type OpenAiPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface OpenAiMessage {
  role: string;
  content: string | OpenAiPart[];
}

async function buildUserContent(m: ChatMessage): Promise<string | OpenAiPart[]> {
  if (!m.images?.length) return m.content;
  const parts: OpenAiPart[] = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  for (const img of m.images) {
    // URL pública direta quando o provedor consegue acessá-la; senão, data URL.
    const url = isPublicHttpUrl(img.url) ? img.url : await toDataUrl(img);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts.length ? parts : m.content;
}

async function toOpenAiMessages(system: string, messages: ChatMessage[], vision: boolean): Promise<OpenAiMessage[]> {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (vision && m.role === 'user' && m.images?.length) {
      out.push({ role: 'user', content: await buildUserContent(m) });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export const openaiAdapter: AiAdapter = {
  kind: 'openai',

  async complete(req, creds) {
    const base = (creds.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const vision = modelSupportsVision('openai', creds.model, creds.baseUrl);
    const messages = await toOpenAiMessages(req.system, req.messages, vision);
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
          messages,
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
    const data = (await res.json()) as ChatCompletionResponse;
    return (data.choices?.[0]?.message?.content ?? '').trim();
  },

  // Valida a chave E confere se o modelo existe (via catalogo /models).
  validateKey(creds) {
    return validateKeyAndModel('openai', creds);
  },
};
