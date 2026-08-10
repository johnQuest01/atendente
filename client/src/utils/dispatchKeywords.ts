/**
 * Parte "hoje. amanha. mes, e todos" em várias palavras de disparo.
 * Separadores: ponto, vírgula, ponto-e-vírgula, quebra de linha e o " e " ligando.
 * Sem distinção de maiúsculas/minúsculas na gravação (lowercase + trim).
 */
export function splitDispatchKeywords(raw: string): string[] {
  const parts = raw
    .split(/[.,;\n]+|\s+e\s+/i)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s !== 'e');

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
