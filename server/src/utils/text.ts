/** Normaliza texto: lowercase, remove acentos e espaços extras. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokeniza em palavras (apenas letras/números). */
export function tokenize(input: string): string[] {
  return normalizeText(input)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/**
 * Substitui variáveis do tipo {{var}} num template.
 * Variáveis não fornecidas viram string vazia.
 */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value == null ? '' : String(value);
  });
}

/** Formata um número como moeda BRL. */
export function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
