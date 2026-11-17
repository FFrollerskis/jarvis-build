// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { Sample } from "@jarvis/self-modification";

/**
 * WP-B3 (D-475), gjennomgang M1 - kumulative månedssummer til trendprognosen mot hardgrensen (EV-16 `forecastBreach`), SEEDET med forbruket FØR dagsvinduet.
 *
 * Feilen: dagssummene kommer fra et AVGRENSET vindu (run-rate: siste 14 døgn; EV-16-seksjonen: siste 15 døgn), men trenden regnet «forbruk hittil i måneden» ved å legge sammen kun vindusdagene. Fra dag 15 i måneden mangler
 * da alt forbruk fra før vinduet, og trenden undervurderer måned-til-dato (jevnt 100 kr/døgn, hardgrense 3000 kr, dag 20: rekkevidden sa ca. 10 døgn, trenden «ca. 16 døgn» = OK). Rettingen: den kumulative serien
 * starter på `forbruk hittil i måneden - sum(vindusdager i måneden)` (= forbruket før vinduet; det første vindusdøgnet kan være delvis, og det regnes riktig inn fordi frøet er forskjellen). Når vinduet dekker hele
 * måneden er frøet 0 og resultatet er som før.
 *
 * Serien bygges kun av TO målinger av samme kilde (`cost_events`): månedssummen og dagssummene. Er de ikke samstemte (dagssummene er STØRRE enn månedssummen utover en liten toleranse for at de leses litt ulikt i tid),
 * kan en trend ikke utledes sikkert og resultatet er `inconsistent_sums` - kalleren viser da UKJENT (aldri en trend som ser grei ut). Ugyldige tall (NaN, negativ, ikke-dato) gir `invalid_input`: ugyldig er aldri OK.
 *
 * Ren funksjon (ingen I/O). Tidsgrenser er UTC (kalleren oppgir `month` som `YYYY-MM` fra samme klokke som dagsnøklene).
 */
export interface DailyCost {
  /** `YYYY-MM-DD` (samme tidssone som `month`). */
  day: string;
  ore: number;
}

export type MonthTrendSamples =
  | { ok: true; samples: Sample[]; seed_ore: number }
  | { ok: false; reason: "invalid_input" | "inconsistent_sums" };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Hvor mye dagssummene kan overstige månedssummen før kildene regnes som usamstemte: et nytt kostnadsrad kan lande mellom de to avlesningene (alltid minst 5 kr, ellers 2 % av månedssummen). */
export function sumToleranceOre(monthToDateOre: number): number {
  return Math.max(500, Math.round(monthToDateOre * 0.02));
}

export function monthTrendSamples(input: { month: string; month_to_date_ore: number; daily: readonly DailyCost[] }): MonthTrendSamples {
  const { month, month_to_date_ore: monthToDate, daily } = input;
  if (typeof month !== "string" || !MONTH.test(month) || typeof monthToDate !== "number" || !Number.isFinite(monthToDate) || monthToDate < 0 || !Array.isArray(daily)) return { ok: false, reason: "invalid_input" };
  const perDay = new Map<string, number>();
  for (const row of daily) {
    // Alle rader valideres (også dager utenfor måneden): en rad som ikke er en dato med et gyldig beløp gjør hele målingen ugyldig.
    if (typeof row !== "object" || row === null || typeof row.day !== "string" || !DAY.test(row.day) || typeof row.ore !== "number" || !Number.isFinite(row.ore) || row.ore < 0) return { ok: false, reason: "invalid_input" };
    if (!row.day.startsWith(`${month}-`)) continue; // dager fra en annen måned hører ikke til denne månedens trend
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.ore); // EV-16-seksjonen har én rad per leverandør og dag
  }
  let windowSum = 0;
  for (const ore of perDay.values()) windowSum += ore;
  const seedRaw = monthToDate - windowSum;
  if (seedRaw < -sumToleranceOre(monthToDate)) return { ok: false, reason: "inconsistent_sums" };
  const seed = Math.max(0, seedRaw);
  let cumulative = seed;
  const samples: Sample[] = [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, ore]) => ({ at: `${day}T12:00:00.000Z`, value: (cumulative += ore) }));
  return { ok: true, samples, seed_ore: seed };
}
