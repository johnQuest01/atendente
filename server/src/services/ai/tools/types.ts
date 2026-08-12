/**
 * Camada neutra de ferramentas (function calling) — agnóstica de provedor.
 * Adapters convertem Tool → formato Anthropic / OpenAI / Gemini.
 * Novas tools: registre em index.ts; não precisa tocar nos adapters.
 */

/** Subconjunto de JSON Schema usado nas declarações de tools. */
export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
};

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** Executa a tool e devolve texto para o modelo. */
export type ToolExecutor = (input: unknown) => Promise<string>;

export interface ToolRegistration {
  tool: Tool;
  execute: ToolExecutor;
}

/** Mapa name → { tool, execute }. */
export type ToolRegistry = Record<string, ToolRegistration>;

export function toolsFromRegistry(registry: ToolRegistry): Tool[] {
  return Object.values(registry).map((r) => r.tool);
}

export function executorsFromRegistry(
  registry: ToolRegistry,
): Record<string, ToolExecutor> {
  const out: Record<string, ToolExecutor> = {};
  for (const [name, reg] of Object.entries(registry)) {
    out[name] = reg.execute;
  }
  return out;
}

/** Executa uma tool do registry; erro vira texto honesto (nunca inventa). */
export async function runTool(
  registry: ToolRegistry | Record<string, ToolExecutor> | undefined,
  name: string,
  input: unknown,
): Promise<string> {
  if (!registry) return `Ferramenta "${name}" indisponível.`;

  const entry = (registry as Record<string, unknown>)[name];
  if (!entry) return `Ferramenta "${name}" não registrada.`;

  const exec: ToolExecutor | undefined =
    typeof entry === 'function'
      ? (entry as ToolExecutor)
      : typeof (entry as ToolRegistration).execute === 'function'
        ? (entry as ToolRegistration).execute
        : undefined;

  if (!exec) return `Ferramenta "${name}" não registrada.`;

  try {
    return await exec(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Erro ao executar ${name}: ${msg.slice(0, 200)}`;
  }
}
