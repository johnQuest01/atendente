import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { validateKeyAndModel } from '../model-catalog';
import { runTool } from '../tools';
import { fetchImageBase64, modelSupportsVision } from '../vision';
import {
  classifyHttpError,
  classifyNetworkError,
  isTruncatedFinishReason,
  type AiAdapter,
  type AiCompletionRequest,
  type ChatMessage,
} from '../types';

/**
 * Adaptador do Google Gemini (Generative Language API).
 * Loop de tool-use via functionDeclarations / functionCall / functionResponse.
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
}

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { functionCall: GeminiFunctionCall }
  | { functionResponse: { name: string; response: { content: string } } };

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
}

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

function toGeminiTools(req: AiCompletionRequest):
  | Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }>
  | undefined {
  if (!req.tools?.length) return undefined;
  return [
    {
      functionDeclarations: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}

export const geminiAdapter: AiAdapter = {
  kind: 'gemini',

  async complete(req, creds) {
    const base = (creds.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(creds.model)}:generateContent?key=${encodeURIComponent(creds.apiKey)}`;
    const vision = modelSupportsVision('gemini', creds.model);
    const tools = toGeminiTools(req);
    const maxIters = env.MAX_TOOL_ITERATIONS;
    let contents = await toGeminiContents(req.messages, vision);
    let lastText = '';
    let finishReason: string | null = null;

    for (let iter = 0; iter < maxIters; iter++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: req.system }] },
            contents,
            generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature },
            ...(tools?.length ? { tools } : {}),
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
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      finishReason = candidate?.finishReason ?? null;
      lastText = parts
        .map((p) => ('text' in p && p.text ? p.text : ''))
        .join('')
        .trim();

      const functionCalls = parts.filter(
        (p): p is { functionCall: GeminiFunctionCall } =>
          'functionCall' in p && Boolean(p.functionCall?.name),
      );

      if (!functionCalls.length) {
        return {
          text: lastText,
          finishReason,
          truncated: isTruncatedFinishReason(finishReason),
        };
      }

      // Turno do modelo com functionCall(s)
      contents = [
        ...contents,
        { role: 'model', parts: functionCalls.map((p) => ({ functionCall: p.functionCall })) },
      ];

      const responseParts: GeminiPart[] = [];
      for (const fc of functionCalls) {
        const name = fc.functionCall.name ?? '';
        logger.info(`Gemini functionCall: ${name}`);
        const content = await runTool(req.toolExecutors, name, fc.functionCall.args ?? {});
        responseParts.push({
          functionResponse: { name, response: { content } },
        });
      }
      contents = [...contents, { role: 'user', parts: responseParts }];
    }

    logger.warn(`Gemini: teto de tool iterations (${maxIters}) — devolvendo texto parcial.`);
    return {
      text: lastText,
      finishReason: finishReason ?? 'max_tool_iterations',
      truncated: isTruncatedFinishReason(finishReason),
    };
  },

  validateKey(creds) {
    return validateKeyAndModel('gemini', creds);
  },
};
