import Anthropic from '@anthropic-ai/sdk';
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

  async validateKey(creds) {
    const base = (creds.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    try {
      // GET /v1/models valida a chave sem consumir tokens.
      const res = await fetch(`${base}/v1/models`, {
        headers: { 'x-api-key': creds.apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return { ok: true, detail: `Chave válida (modelo ${creds.model}).` };
      if (res.status === 401) return { ok: false, detail: 'Chave inválida ou revogada (401).' };
      return { ok: false, detail: `Anthropic respondeu HTTP ${res.status}.` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'Falha ao validar.' };
    }
  },
};
