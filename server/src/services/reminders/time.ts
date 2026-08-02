/**
 * Conversões de fuso para os lembretes, usando apenas `Intl` — sem dependência
 * nova no projeto.
 *
 * O ponto central: a IA devolve um horário de PAREDE ("2026-08-03T09:00", o que
 * o dono leria no relógio dele) e nós convertemos para o instante UTC correto
 * no fuso da empresa. Fazer o contrário — pedir o offset para o modelo — erra
 * no horário de verão e em datas futuras.
 */

export const DEFAULT_TZ = 'America/Sao_Paulo';

const WEEKDAYS: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = domingo
}

const partsFormatter = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsFormatter.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatter.set(tz, f);
  }
  return f;
}

/** Como o relógio do fuso `tz` mostra o instante `date`. */
export function toWallClock(date: Date, tz: string): WallClock {
  const parts = formatterFor(tz).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  const hour = Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl pode devolver 24 para meia-noite em hour12:false.
    hour: hour === 24 ? 0 : hour,
    minute: Number(map.minute),
    weekday: WEEKDAYS[(map.weekday ?? 'SUN').toUpperCase().slice(0, 3)] ?? 0,
  };
}

function offsetMs(date: Date, tz: string): number {
  const wc = toWallClock(date, tz);
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, date.getUTCSeconds());
  return asUtc - date.getTime();
}

/**
 * Horário de parede no fuso `tz` → instante UTC. A segunda passada corrige a
 * virada do horário de verão, quando o offset do palpite difere do real.
 */
export function fromWallClock(
  wc: { year: number; month: number; day: number; hour: number; minute: number },
  tz: string,
): Date {
  const guess = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute);
  let date = new Date(guess - offsetMs(new Date(guess), tz));
  const check = toWallClock(date, tz);
  if (check.hour !== wc.hour || check.day !== wc.day) {
    date = new Date(guess - offsetMs(date, tz));
  }
  return date;
}

/** "2026-08-03T09:00" (sem fuso) no relógio do dono → instante UTC. */
export function parseLocalIso(value: string, tz: string): Date | null {
  const m = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const date = fromWallClock(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      // Sem hora explícita o combinado é 09:00, e o texto de confirmação avisa.
      hour: m[4] ? Number(m[4]) : 9,
      minute: m[5] ? Number(m[5]) : 0,
    },
    tz,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Valida a regra de recorrência aceita pelo agendador. */
export function isValidRecurrence(rule: string): boolean {
  const r = rule.trim().toLowerCase();
  if (r === 'daily') return true;
  const weekly = r.match(/^weekly:([a-z]{3})$/);
  if (weekly) return weekly[1].toUpperCase() in WEEKDAYS;
  const monthly = r.match(/^monthly:(\d{1,2})$/);
  if (monthly) {
    const day = Number(monthly[1]);
    return day >= 1 && day <= 31;
  }
  return false;
}

/**
 * Próximo disparo de uma recorrência, sempre DEPOIS de `after`, preservando o
 * horário do disparo anterior no fuso do lembrete.
 *
 * 'monthly:31' em mês curto cai no último dia do mês — melhor lembrar no dia 30
 * do que pular fevereiro inteiro.
 */
export function nextOccurrence(
  rule: string,
  previous: Date,
  tz: string,
  after: Date = new Date(),
): Date | null {
  const r = rule.trim().toLowerCase();
  const base = toWallClock(previous, tz);

  if (r === 'daily') {
    let candidate = previous;
    let guard = 0;
    while (candidate <= after && guard < 400) {
      const wc = toWallClock(candidate, tz);
      candidate = fromWallClock({ ...wc, day: wc.day + 1 }, tz);
      guard += 1;
    }
    return candidate;
  }

  const weekly = r.match(/^weekly:([a-z]{3})$/);
  if (weekly) {
    const target = WEEKDAYS[weekly[1].toUpperCase()];
    if (target === undefined) return null;
    let candidate = previous;
    let guard = 0;
    do {
      const wc = toWallClock(candidate, tz);
      const delta = (target - wc.weekday + 7) % 7 || 7;
      candidate = fromWallClock({ ...wc, day: wc.day + delta }, tz);
      guard += 1;
    } while (candidate <= after && guard < 60);
    return candidate;
  }

  const monthly = r.match(/^monthly:(\d{1,2})$/);
  if (monthly) {
    const targetDay = Number(monthly[1]);
    let year = base.year;
    let month = base.month;
    let guard = 0;
    for (;;) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const day = Math.min(targetDay, lastDay);
      const candidate = fromWallClock({ year, month, day, hour: base.hour, minute: base.minute }, tz);
      if (candidate > after) return candidate;
      guard += 1;
      if (guard > 48) return null;
    }
  }

  return null;
}

const DIAS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** "quinta-feira, 03/08 às 09:00" — para confirmações e listas no WhatsApp. */
export function formatForOwner(date: Date, tz: string): string {
  const wc = toWallClock(date, tz);
  const dd = String(wc.day).padStart(2, '0');
  const mm = String(wc.month).padStart(2, '0');
  const hh = String(wc.hour).padStart(2, '0');
  const mi = String(wc.minute).padStart(2, '0');
  return `${DIAS_PT[wc.weekday]}, ${dd}/${mm} às ${hh}:${mi}`;
}

export function weekdayNamePt(date: Date, tz: string): string {
  return DIAS_PT[toWallClock(date, tz).weekday];
}
