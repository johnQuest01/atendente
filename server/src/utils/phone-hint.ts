/**
 * Dono cita o final do telefone pra desambiguar: "Jurandir final 3934".
 */

export function extractPhoneHint(text: string): string | null {
  const raw = text.replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  const labeled = raw.match(
    /(?:final(?:\s+do\s+n[uú]mero)?|termina(?:ndo)?\s+com|n[uú]mero(?:\s+final)?|(?:com\s+o\s+)?final)\s*(?:[eé]\s+)?(\d[\d.\s-]{2,16}\d)/i,
  );
  if (labeled?.[1]) {
    const d = labeled[1].replace(/\D/g, '');
    if (d.length >= 4 && d.length <= 13) return d;
  }

  const ofNum = raw.match(/\b(?:do|de|[eé]\s+o)\s+(\d{4,13})\b/i);
  if (ofNum?.[1]) return ofNum[1].replace(/\D/g, '');

  const compact = raw.replace(/\D/g, '');
  if (compact.length >= 10 && compact.length <= 13) return compact;

  const token = raw.match(/(?:^|[\s,;])(\d{4,8})(?:$|[\s,;.!?])/);
  if (token?.[1]) return token[1];

  return null;
}

export function phoneMatchesHint(phone: string, hint: string): boolean {
  const p = phone.replace(/\D/g, '');
  const h = hint.replace(/\D/g, '');
  if (!p || !h) return false;
  if (h.length >= 10) {
    return p === h || p.endsWith(h) || h.endsWith(p) || p.endsWith(h.slice(-8));
  }
  return p.endsWith(h);
}
