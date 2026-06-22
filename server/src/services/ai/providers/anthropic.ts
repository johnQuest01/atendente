import Anthropic from '@anthropic-ai/sdk';
import { validateKeyAndModel } from '../model-catalog';
import {
  AiProviderError,
  classifyHttpError,
  classifyNetworkError,
  type AiAdapter,
  type ChatMessage,
} from '../types';

const DEFAULT_BASE = 'https://api.anthropic.com';

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
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
      timeout: 30_000,
    });
    try {
      const response = await client.messages.create({
        model: creds.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
      });
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
    } catch (err) {
      throw classifySdkError(err);
    }
  },

  // Valida a chave E confere se o modelo existe (via catalogo /v1/models).
  validateKey(creds) {
    return validateKeyAndModel('anthropic', creds);
  },
};
