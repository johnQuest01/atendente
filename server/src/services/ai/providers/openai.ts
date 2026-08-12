import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { validateKeyAndModel } from '../model-catalog';
import { runTool } from '../tools';
import { isPublicHttpUrl, modelSupportsVision, toDataUrl } from '../vision';
import {
  classifyHttpError,
  classifyNetworkError,
  isTruncatedFinishReason,
  isUnsupportedTemperature,
  type AiAdapter,
  type AiCompletionRequest,
  type ChatMessage,
} from '../types';

/**
 * Adaptador "OpenAI Chat Completions". Cobre OpenAI/ChatGPT e qualquer API
 * compativel apenas trocando a `baseUrl`/`model`:
 *   - OpenAI:     https://api.openai.com/v1
 *   - Groq:       https://api.groq.com/openai/v1
 *   - OpenRouter: https://openrouter.ai/api/v1
 *   - xAI Grok:   https://api.x.ai/v1
 *
 * Loop de tool-use (function calling) quando `req.tools` está presente.
 * Se o endpoint/modelo não suportar tools, degrada e segue sem tools.
 */

const DEFAULT_BASE = 'https://api.openai.com/v1';

interface OpenAiToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
      role?: string;
    };
    finish_reason?: string;
  }>;
}

type OpenAiPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

type OpenAiMessage =
  | { role: string; content: string | OpenAiPart[] | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

async function buildUserContent(m: ChatMessage): Promise<string | OpenAiPart[]> {
  if (!m.images?.length) return m.content;
  const parts: OpenAiPart[] = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  for (const img of m.images) {
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

function toOpenAiTools(req: AiCompletionRequest): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}> | undefined {
  if (!req.tools?.length) return undefined;
  return req.tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function looksLikeToolsUnsupported(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  const b = body.toLowerCase();
  return (
    b.includes('tool') ||
    b.includes('function') ||
    b.includes('functions') ||
    b.includes('tool_choice') ||
    b.includes('not support')
  );
}

export const openaiAdapter: AiAdapter = {
  kind: 'openai',

  async complete(req, creds) {
    const base = (creds.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const vision = modelSupportsVision('openai', creds.model, creds.baseUrl);
    let messages = await toOpenAiMessages(req.system, req.messages, vision);
    let tools = toOpenAiTools(req);
    let toolsDisabled = false;
    const maxIters = env.MAX_TOOL_ITERATIONS;
    let lastText = '';
    let finishReason: string | null = null;

    const send = async (withTemp: boolean, withTools: boolean): Promise<Response> => {
      const payload: Record<string, unknown> = {
        model: creds.model,
        max_tokens: req.maxTokens,
        messages,
      };
      if (withTemp) payload.temperature = req.temperature;
      if (withTools && tools?.length) payload.tools = tools;
      return fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45_000),
      });
    };

    const callOnce = async (): Promise<ChatCompletionResponse> => {
      let res: Response;
      try {
        res = await send(true, !toolsDisabled);
        if (!res.ok && res.status === 400) {
          const peek = await res.clone().text().catch(() => '');
          if (isUnsupportedTemperature(res.status, peek)) {
            res = await send(false, !toolsDisabled);
          } else if (!toolsDisabled && tools?.length && looksLikeToolsUnsupported(res.status, peek)) {
            // Grok/alguns endpoints: degrada sem tools em vez de quebrar.
            logger.warn('OpenAI/Grok: tools não suportadas neste modelo — seguindo sem tools.');
            toolsDisabled = true;
            tools = undefined;
            res = await send(true, false);
            if (!res.ok && res.status === 400) {
              const peek2 = await res.clone().text().catch(() => '');
              if (isUnsupportedTemperature(res.status, peek2)) res = await send(false, false);
            }
          }
        }
      } catch (err) {
        throw classifyNetworkError(err);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (!toolsDisabled && tools?.length && looksLikeToolsUnsupported(res.status, body)) {
          logger.warn('OpenAI/Grok: tools rejeitadas — retentando sem tools.');
          toolsDisabled = true;
          tools = undefined;
          return callOnce();
        }
        throw classifyHttpError(res.status, body);
      }
      return (await res.json()) as ChatCompletionResponse;
    };

    for (let iter = 0; iter < maxIters; iter++) {
      const data = await callOnce();
      const choice = data.choices?.[0];
      const message = choice?.message;
      finishReason = choice?.finish_reason ?? null;
      lastText = (message?.content ?? '').trim();
      const toolCalls = message?.tool_calls ?? [];

      if (!toolCalls.length || toolsDisabled) {
        return {
          text: lastText,
          finishReason,
          truncated: isTruncatedFinishReason(finishReason),
        };
      }

      messages.push({
        role: 'assistant',
        content: message?.content ?? null,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const name = tc.function?.name ?? '';
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          args = {};
        }
        logger.info(`OpenAI tool_call: ${name}`);
        const content = await runTool(req.toolExecutors, name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content });
      }
    }

    logger.warn(`OpenAI: teto de tool iterations (${maxIters}) — devolvendo texto parcial.`);
    return {
      text: lastText,
      finishReason: finishReason ?? 'max_tool_iterations',
      truncated: isTruncatedFinishReason(finishReason),
    };
  },

  validateKey(creds) {
    return validateKeyAndModel('openai', creds);
  },
};
