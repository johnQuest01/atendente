import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { validateKeyAndModel } from '../model-catalog';
import { runTool } from '../tools';
import { anthropicMediaType, fetchImageBase64, modelSupportsVision } from '../vision';
import {
  AiProviderError,
  classifyHttpError,
  classifyNetworkError,
  isTruncatedFinishReason,
  isUnsupportedTemperature,
  type AiAdapter,
  type AiCompletionRequest,
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

/** O erro do SDK é a recusa de `temperature` (modelos novos)? */
function temperatureRejected(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = Number((err as { status?: unknown }).status);
    const e = err as { error?: unknown; message?: unknown };
    const body = JSON.stringify(e.error ?? e.message ?? '');
    return isUnsupportedTemperature(status, body);
  }
  return false;
}

function toAnthropicTools(req: AiCompletionRequest): Anthropic.Messages.Tool[] | undefined {
  if (!req.tools?.length) return undefined;
  return req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
  }));
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
    const tools = toAnthropicTools(req);
    const maxIters = env.MAX_TOOL_ITERATIONS;
    let messages = await toAnthropicMessages(req.messages, vision);
    let lastText = '';
    let finishReason: string | null = null;

    try {
      for (let iter = 0; iter < maxIters; iter++) {
        // Persona estável com cache_control; contexto dinâmico e a msg do cliente ficam fora.
        // cast: SDKs antigos tipam TextBlockParam sem cache_control; a API Anthropic aceita.
        const system = (
          req.systemCached?.trim()
            ? [
                {
                  type: 'text' as const,
                  text: req.systemCached,
                  cache_control: { type: 'ephemeral' as const },
                },
                ...(req.systemDynamic?.trim()
                  ? [{ type: 'text' as const, text: req.systemDynamic }]
                  : []),
              ]
            : req.system
        ) as Anthropic.MessageCreateParamsNonStreaming['system'];

        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model: creds.model,
          max_tokens: req.maxTokens,
          system,
          messages,
          ...(tools?.length ? { tools } : {}),
        };

        let response: Anthropic.Message;
        try {
          response = await client.messages.create({ ...params, temperature: req.temperature });
        } catch (err) {
          if (temperatureRejected(err)) {
            response = await client.messages.create(params);
          } else {
            throw err;
          }
        }

        finishReason = response.stop_reason ?? null;
        lastText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();

        if (response.stop_reason !== 'tool_use') {
          return {
            text: lastText,
            finishReason,
            truncated: isTruncatedFinishReason(finishReason),
          };
        }

        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (!toolUseBlocks.length) {
          return {
            text: lastText,
            finishReason,
            truncated: isTruncatedFinishReason(finishReason),
          };
        }

        messages = [
          ...messages,
          { role: 'assistant', content: response.content },
          {
            role: 'user',
            content: await Promise.all(
              toolUseBlocks.map(async (block) => {
                logger.info(`Anthropic tool_use: ${block.name}`);
                const content = await runTool(req.toolExecutors, block.name, block.input);
                return {
                  type: 'tool_result' as const,
                  tool_use_id: block.id,
                  content,
                };
              }),
            ),
          },
        ];
      }

      logger.warn(`Anthropic: teto de tool iterations (${maxIters}) — devolvendo texto parcial.`);
      return {
        text: lastText,
        finishReason: finishReason ?? 'max_tool_iterations',
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
