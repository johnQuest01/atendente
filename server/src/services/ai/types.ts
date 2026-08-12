/**
 * Contrato comum dos provedores de IA (Claude, OpenAI/ChatGPT, Gemini, etc.).
 * O orquestrador fala com qualquer provedor por esta interface, o que permite
 * TROCAR de IA e fazer FAILOVER automatico sem mexer no resto do sistema.
 */

import type { Tool, ToolExecutor } from './tools/types';

export type { Tool, ToolExecutor } from './tools/types';

export type AiKind = 'anthropic' | 'openai' | 'gemini';

/**
 * Classificacao do erro de um provedor — define a estrategia de failover:
 * - auth        chave invalida/revogada -> pular e cooldown longo
 * - quota       creditos/cota esgotados  -> pular e cooldown longo
 * - rate_limit  limite por minuto (429)  -> tentar proximo e cooldown curto
 * - transient   5xx/timeout/rede         -> tentar proximo e cooldown curto
 * - bad_request payload invalido (400)   -> tentar proximo e cooldown medio
 */
export type AiFailureKind = 'auth' | 'quota' | 'rate_limit' | 'transient' | 'bad_request';

export class AiProviderError extends Error {
  public readonly kind: AiFailureKind;
  public readonly status?: number;

  constructor(kind: AiFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'AiProviderError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ChatImage {
  /** URL pública da imagem (preferida quando acessível ao provedor externo). */
  url?: string;
  /** Bytes em base64 (sem o prefixo "data:"). Usado quando não há URL pública. */
  base64?: string;
  mime?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Imagens anexadas ao turno (somente role 'user'); provedores com visão as leem. */
  images?: ChatImage[];
}

export interface AiCredentials {
  apiKey: string;
  /** Sobrescreve a URL base padrao do adaptador (Groq/OpenRouter/local). */
  baseUrl?: string | null;
  model: string;
}

export interface AiCompletionRequest {
  /**
   * System prompt completo (persona + contexto dinâmico).
   * Sempre preenchido — adapters sem cache usam só isto.
   */
  system: string;
  /**
   * Bloco estável (persona) para prompt caching (Anthropic cache_control).
   * A mensagem do cliente fica em `messages`, fora do cache.
   */
  systemCached?: string;
  /** Contexto que muda (catálogo, cliente, memórias) — fora do cache. */
  systemDynamic?: string;
  /** Historico normalizado (alterna user/assistant, comeca em user). */
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  /**
   * Ferramentas neutras (function calling). O orchestrator pode injetá-las.
   * Cada adapter converte para o protocolo do provedor e roda o loop de tool-use.
   */
  tools?: Tool[];
  /** Executores por nome da tool — mesma execução em todos os adapters. */
  toolExecutors?: Record<string, ToolExecutor>;
}

/** Resultado de uma completion, com motivo de parada (truncamento). */
export interface AiCompletionResult {
  text: string;
  /** finish_reason / stop_reason bruto do provedor. */
  finishReason?: string | null;
  /** True se a resposta foi cortada por limite de tokens. */
  truncated?: boolean;
}

export interface AiKeyCheck {
  ok: boolean;
  detail: string;
}

/** Adaptador concreto de um provedor de IA. */
export interface AiAdapter {
  kind: AiKind;
  /** Gera a resposta. Em falha, lanca AiProviderError classificado. */
  complete(req: AiCompletionRequest, creds: AiCredentials): Promise<AiCompletionResult>;
  /** Valida a chave/credenciais (para o painel e o health-check), sem gastar tokens quando possivel. */
  validateKey(creds: AiCredentials): Promise<AiKeyCheck>;
}

/** Interpreta finish_reason comum entre provedores. */
export function isTruncatedFinishReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r === 'max_tokens' || r === 'length' || r === 'max_output_tokens';
}

/**
 * A API recusou o parâmetro `temperature`? Os modelos mais novos (ex.: Claude
 * opus-5/sonnet-5/fable-5 e os GPT de raciocínio) DEPRECIARAM `temperature` e
 * respondem 400 quando ele é enviado. Nesse caso, o adaptador refaz a chamada
 * SEM o parâmetro, em vez de falhar.
 */
export function isUnsupportedTemperature(status: number, body: string): boolean {
  if (status !== 400) return false;
  const b = body.toLowerCase();
  if (!b.includes('temperature')) return false;
  return /deprecat|unsupported|not supported|does not support|only the default|no longer/.test(b);
}

/** Converte uma resposta HTTP de erro num AiProviderError classificado. */
export function classifyHttpError(status: number, body: string): AiProviderError {
  const lower = body.toLowerCase();
  const looksLikeQuota =
    lower.includes('insufficient_quota') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('credit balance') ||
    lower.includes('billing') ||
    lower.includes('quota');
  // Gemini (e outros) as vezes devolvem 400 para chave invalida.
  const looksLikeAuth =
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('invalid api key') ||
    lower.includes('unauthorized') ||
    lower.includes('permission_denied');

  if (status === 401 || status === 403 || (status === 400 && looksLikeAuth)) {
    return new AiProviderError('auth', `Chave inválida ou sem permissão (HTTP ${status}).`, status);
  }
  if (status === 402 || (status === 429 && looksLikeQuota)) {
    return new AiProviderError('quota', `Cota/créditos esgotados (HTTP ${status}).`, status);
  }
  if (status === 429) {
    return new AiProviderError('rate_limit', `Limite de requisições atingido (HTTP ${status}).`, status);
  }
  if (status >= 500) {
    return new AiProviderError('transient', `Erro temporário do provedor (HTTP ${status}).`, status);
  }
  if (status === 400) {
    return new AiProviderError('bad_request', `Requisição rejeitada (HTTP ${status}): ${body.slice(0, 160)}`, status);
  }
  return new AiProviderError('transient', `HTTP ${status}: ${body.slice(0, 160)}`, status);
}

/** Normaliza erros de rede/timeout (fetch) em AiProviderError transitorio. */
export function classifyNetworkError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new AiProviderError('transient', msg.includes('timeout') ? 'Tempo esgotado ao chamar o provedor.' : msg);
}
