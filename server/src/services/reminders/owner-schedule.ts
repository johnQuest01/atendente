import { DEFAULT_TZ, formatForOwner, fromWallClock, toWallClock } from './time';

/** 0 = domingo … 6 = sábado (igual toWallClock). */
export type WeekdayKey = '0' | '1' | '2' | '3' | '4' | '5' | '6';

export interface DayWindow {
  start: string;
  end: string;
}

export type WeeklyHours = Partial<Record<WeekdayKey, DayWindow | null>>;

export function parseHhmm(value: string): { hour: number; minute: number } | null {
  const m = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function toMinutes(value: string): number | null {
  const p = parseHhmm(value);
  if (!p) return null;
  return p.hour * 60 + p.minute;
}

export function normalizeWeeklyHours(raw: unknown): WeeklyHours {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: WeeklyHours = {};
  for (let d = 0; d <= 6; d++) {
    const key = String(d) as WeekdayKey;
    const v = (raw as Record<string, unknown>)[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const start = typeof (v as { start?: unknown }).start === 'string' ? (v as { start: string }).start : '';
    const end = typeof (v as { end?: unknown }).end === 'string' ? (v as { end: string }).end : '';
    if (!parseHhmm(start) || !parseHhmm(end)) continue;
    if (start.slice(0, 5) === end.slice(0, 5)) continue;
    out[key] = { start: start.slice(0, 5), end: end.slice(0, 5) };
  }
  return out;
}

function windowCovers(
  win: DayWindow,
  nowM: number,
  phase: 'start-day' | 'end-day',
): boolean {
  const start = toMinutes(win.start);
  const end = toMinutes(win.end);
  if (start === null || end === null || start === end) return false;
  if (start < end) {
    return phase === 'start-day' && nowM >= start && nowM < end;
  }
  // Atravessa meia-noite: no dia do start vale a partir de start; no dia do
  // end vale até end.
  if (phase === 'start-day') return nowM >= start;
  return nowM < end;
}

export function isOnDuty(hours: WeeklyHours, now: Date, tz: string = DEFAULT_TZ): boolean {
  const wc = toWallClock(now, tz);
  const nowM = wc.hour * 60 + wc.minute;
  const today = String(wc.weekday) as WeekdayKey;
  const yesterday = String((wc.weekday + 6) % 7) as WeekdayKey;
  const todayWin = hours[today];
  if (todayWin && windowCovers(todayWin, nowM, 'start-day')) return true;
  const yWin = hours[yesterday];
  if (yWin && windowCovers(yWin, nowM, 'end-day')) return true;
  return false;
}

function atWall(
  wc: { year: number; month: number; day: number },
  hhmm: string,
  tz: string,
): Date | null {
  const p = parseHhmm(hhmm);
  if (!p) return null;
  return fromWallClock({ ...wc, hour: p.hour, minute: p.minute }, tz);
}

function addDays(
  wc: { year: number; month: number; day: number; hour: number; minute: number },
  days: number,
  tz: string,
) {
  return toWallClock(
    fromWallClock({ year: wc.year, month: wc.month, day: wc.day + days, hour: 12, minute: 0 }, tz),
    tz,
  );
}

/** Próximo instante em que a janela ABRE (quando está fechada). */
export function nextOpenAt(hours: WeeklyHours, now: Date, tz: string = DEFAULT_TZ): Date | null {
  if (isOnDuty(hours, now, tz)) return now;
  const wc = toWallClock(now, tz);
  const nowM = wc.hour * 60 + wc.minute;
  for (let d = 0; d <= 7; d++) {
    const weekday = (wc.weekday + d) % 7;
    const key = String(weekday) as WeekdayKey;
    const win = hours[key];
    if (!win) continue;
    const start = toMinutes(win.start);
    const end = toMinutes(win.end);
    if (start === null || end === null || start === end) continue;
    if (d === 0) {
      if (nowM < start) {
        return atWall(wc, win.start, tz);
      }
      continue;
    }
    const day = addDays(wc, d, tz);
    return atWall(day, win.start, tz);
  }
  return null;
}

/** Quando a janela ATUAL fecha (só se estiver de plantão). */
export function currentWindowEndAt(
  hours: WeeklyHours,
  now: Date,
  tz: string = DEFAULT_TZ,
): Date | null {
  if (!isOnDuty(hours, now, tz)) return null;
  const wc = toWallClock(now, tz);
  const nowM = wc.hour * 60 + wc.minute;
  const today = String(wc.weekday) as WeekdayKey;
  const yesterday = String((wc.weekday + 6) % 7) as WeekdayKey;
  const todayWin = hours[today];
  if (todayWin && windowCovers(todayWin, nowM, 'start-day')) {
    const start = toMinutes(todayWin.start)!;
    const end = toMinutes(todayWin.end)!;
    if (start < end) return atWall(wc, todayWin.end, tz);
    const tmr = addDays(wc, 1, tz);
    return atWall(tmr, todayWin.end, tz);
  }
  const yWin = hours[yesterday];
  if (yWin && windowCovers(yWin, nowM, 'end-day')) {
    return atWall(wc, yWin.end, tz);
  }
  return null;
}

export function secretaryIsAvailable(input: {
  secretaryEnabled: boolean;
  scheduleEnabled: boolean;
  weeklyHours: WeeklyHours;
  now?: Date;
  tz?: string;
}): boolean {
  if (!input.secretaryEnabled) return false;
  if (!input.scheduleEnabled) return true;
  return isOnDuty(input.weeklyHours, input.now ?? new Date(), input.tz ?? DEFAULT_TZ);
}

export function offDutyMessage(hours: WeeklyHours, now: Date = new Date(), tz: string = DEFAULT_TZ): string {
  const next = nextOpenAt(hours, now, tz);
  if (!next) {
    return 'Estou fora do horário agora. Não tem dia/hora cadastrado pra mim nesta semana.';
  }
  return `Estou fora do horário agora. Volto ${formatForOwner(next, tz)}.`;
}

export function defaultWeekdayHours(): WeeklyHours {
  const win: DayWindow = { start: '08:00', end: '18:00' };
  return { '1': win, '2': win, '3': win, '4': win, '5': win };
}
