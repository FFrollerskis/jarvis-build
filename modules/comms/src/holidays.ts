/**
 * WP-G1c (D-481, JARVIS-112 g2): norske offentlige høytidsdager og søndager, beregnet i ren kode (ingen ekstern tjeneste, ingen nettverkskall). Brukes av ringevinduet (`call_window` i `policy.ts`): en AI-samtale
 * ringes aldri en søndag eller en helligdag. Stille timer for MELDINGER er uendret (de gjelder klokkeslett, ikke kalenderdag).
 *
 * Kilde for dagene (lov om helligdager og helligdagsfred, kjent fra offentlig informasjon; IKKE verifisert mot Lovdata i denne økten): faste dager 1. januar, 1. mai, 17. mai, 1. og 2. juledag; bevegelige dager regnet fra 1. påskedag (P):
 * skjærtorsdag (P-3), langfredag (P-2), 1. påskedag (P), 2. påskedag (P+1), Kristi himmelfartsdag (P+39), 1. pinsedag (P+49) og 2. pinsedag (P+50). Julaften og nyttårsaften er IKKE helligdager i loven (bare vanlig praksis med
 * tidlig stenging) og er derfor ikke med; det samme gjelder helligdagsfredens klokkeslett fra kvelden før (ikke bygget, se runbook §10).
 *
 * 1. påskedag beregnes med den gregorianske algoritmen til Meeus/Jones/Butcher (gyldig for hele den gregorianske kalenderen, år 1583 og utover); testene sjekker den mot kjente datoer og en uavhengig algoritme (Gauss).
 */

/** Kalenderdato (ikke tidspunkt): år, måned 1-12, dag 1-31. */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** 1. påskedag (påskesøndag) i et gregorianske år (år >= 1583). */
export function easterSunday(year: number): CalendarDate {
  if (!Number.isInteger(year) || year < 1583 || year > 9999) throw new RangeError("easterSunday: year must be an integer in 1583..9999");
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

const DAY_MS = 86_400_000;

/** Dato + `days` dager (kan være negativt) i den gregorianske kalenderen. Regnes i UTC, så sommertid aldri flytter en dato. */
function addDays(date: CalendarDate, days: number): CalendarDate {
  const t = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

const key = (d: CalendarDate): number => d.year * 10_000 + d.month * 100 + d.day;

export interface NorwegianHoliday {
  readonly date: CalendarDate;
  /** Norsk navn (til visning i revisjonsspor/test; aldri en del av en avgjørelse). */
  readonly name: string;
}

/** Alle norske offentlige høytidsdager i et år, sortert på dato (de fem faste og de syv påskebaserte). */
export function norwegianHolidays(year: number): readonly NorwegianHoliday[] {
  const easter = easterSunday(year);
  const list: NorwegianHoliday[] = [
    { date: { year, month: 1, day: 1 }, name: "Nyttårsdag" },
    { date: addDays(easter, -3), name: "Skjærtorsdag" },
    { date: addDays(easter, -2), name: "Langfredag" },
    { date: easter, name: "1. påskedag" },
    { date: addDays(easter, 1), name: "2. påskedag" },
    { date: { year, month: 5, day: 1 }, name: "Arbeidernes dag" },
    { date: { year, month: 5, day: 17 }, name: "Grunnlovsdagen" },
    { date: addDays(easter, 39), name: "Kristi himmelfartsdag" },
    { date: addDays(easter, 49), name: "1. pinsedag" },
    { date: addDays(easter, 50), name: "2. pinsedag" },
    { date: { year, month: 12, day: 25 }, name: "1. juledag" },
    { date: { year, month: 12, day: 26 }, name: "2. juledag" }
  ];
  return list.sort((x, y) => key(x.date) - key(y.date));
}

/** Er datoen en norsk offentlig høytidsdag? */
export function isNorwegianHoliday(date: CalendarDate): boolean {
  const k = key(date);
  return norwegianHolidays(date.year).some((h) => key(h.date) === k);
}

/** Ukedag for en kalenderdato: 0 = søndag ... 6 = lørdag. */
export function weekday(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Kalenderdatoen i en tidssone for et tidspunkt (Intl; `null` hvis sonen er ugyldig - kalleren behandler det fail-closed). */
export function localCalendarDate(now: Date, timeZone: string): CalendarDate | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
    const year = part("year");
    const month = part("month");
    const day = part("day");
    return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) ? { year, month, day } : null;
  } catch {
    return null;
  }
}

/**
 * Er den lokale kalenderdagen en søndag eller en norsk helligdag? `null`/ugyldig sone gir `true` (FAIL-CLOSED: en samtale ringes aldri når datoen ikke kan fastslås).
 * Brukes kun for ringevinduet. Lørdag er en vanlig dag i denne regelen.
 */
export function isSundayOrNorwegianHoliday(now: Date, timeZone: string): boolean {
  const date = localCalendarDate(now, timeZone);
  if (date === null) return true;
  return weekday(date) === 0 || isNorwegianHoliday(date);
}
