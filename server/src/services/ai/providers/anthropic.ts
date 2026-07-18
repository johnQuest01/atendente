import Anthropic from '@anthropic-ai/sdk';
import { validateKeyAndModel } from '../model-catalog';
import { anthropicMediaType, fetchImageBase64, modelSupportsVision } from '../vision';
import {
  AiProviderError,
  classifyHttpError,
  classifyNetworkError,
  isTruncatedFinishReason,
  type AiAdapter,
  type ChatMessage,
} from '../types';

const DEFAULT_BASE = 'https://api.anthropic.com';

/** Conteúdo de um turno do cliente — com imagens (base64) quando houver. */
async function toContent(m: ChatMessage): Promise<Anthropic.MessageParam['content']> {
  if (!m.images?.length) return m.content;
  const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  if (m.content) blocks.push({ type: 'text', text: m.content });
  for (const img of m.images) {
    const b = await fetchImageBase64(img);
    if (b) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: anthropicMediaType(b.mime), data: b.base64 },
      });
    }
  }
  return blocks.length ? blocks : m.content;
}

async function toAnthropicMessages(messages: ChatMessage[], vision: boolean): Promise<Anthropic.MessageParam[]> {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (vision && m.role === 'user' && m.images?.length) {
      out.push({ role: m.role, content: await toContent(m) });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function classifySdkError(err: unknown): AiProviderError {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = Number((err as { status?: unknown }).status);
    if (!Number.isNaN(status) && status > 0) {
      const e = err as { error?: unknown; message?: unknown };
      const body = JSON.stringify(e.error ?? e.message ?? '');
      return classifyHttpError(status, body);
    }
  }
  return classifyNetworkError(err);
}

export const anthropicAdapter: AiAdapter = {
  kind: 'anthropic',

  async complete(req, creds) {
    const client = new Anthropic({
      apiKey: creds.apiKey,
      baseURL: creds.baseUrl || DEFAULT_BASE,
      timeout: 45_000,
    });
    const vision = modelSupportsVision('anthropic', creds.model);
    try {
      const response = await client.messages.create({
        model: creds.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: req.system,
        messages: await toAnthropicMessages(req.messages, vision),
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const finishReason = response.stop_reason ?? null;
      return {
        text,
        finishReason,
        truncated: isTruncatedFinishReason(finishReason),
      };
    } catch (err) {
      throw classifySdkError(err);
    }
  },

  // Valida a chave E confere se o modelo existe (via catalogo /v1/models).
  validateKey(creds) {
    return validateKeyAndModel('anthropic', creds);
  },
};
