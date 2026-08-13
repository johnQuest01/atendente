/**
 * Registry padrão de tools da plataforma.
 * Para adicionar stock_quote etc.: registre aqui — adapters não mudam.
 */

import {
  executorsFromRegistry,
  toolsFromRegistry,
  type Tool,
  type ToolExecutor,
  type ToolRegistry,
} from './types';
import { executeWebSearch, isWebSearchToolAvailable, webSearchTool } from './web-search';

export type { Tool, ToolExecutor, ToolRegistry } from './types';
export { runTool } from './types';
export { executeWebSearch, isWebSearchToolAvailable, webSearchTool } from './web-search';
export { buildOwnerToolRegistry, type OwnerToolContext } from './owner-actions';

/** Tools disponíveis agora (só as que têm credencial/config). */
export function buildDefaultToolRegistry(): ToolRegistry {
  const registry: ToolRegistry = {};
  // web_search só entra se houver chave (Tavily/Brave) — sem chave, agente segue sem tool.
  if (isWebSearchToolAvailable()) {
    registry.web_search = { tool: webSearchTool, execute: executeWebSearch };
  }
  return registry;
}

export function registryAsRequestFields(registry: ToolRegistry): {
  tools: Tool[];
  toolExecutors: Record<string, ToolExecutor>;
} {
  return {
    tools: toolsFromRegistry(registry),
    toolExecutors: executorsFromRegistry(registry),
  };
}
