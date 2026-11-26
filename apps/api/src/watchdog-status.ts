// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { Observation } from "@jarvis/executive";
import type { ProducerRunStore } from "@jarvis/incidents";

/**
 * WP-OPS2a K1 (EV-1/H2, JARVIS-041-resten): leseren for `watchdog`-området i selvdiagnosen. Vakthunden kjører i worker-prosessen, API-prosessen ser den ikke direkte. Det ENE varige sporet er raden i `incident_producer_runs`
 * (producer = `watchdog`, migrasjon 098) som den eksisterende broen (`createWatchdogIncidentBridge`) skriver for HVERT fullførte tikk når incident-produsentene er på. Denne leseren leser den raden og skriver ALDRI noe (ingen ny
 * skrivevei, ingen ny tabell).
 *
 * Hva raden sier og ikke sier:
 *  - `last_started_at` er når siste tikk ble registrert, så alderen er «tid siden vakthunden sist fullførte et tikk». Over 3 x produsent-intervallet (standard 15 min; SAMME regel som driftsstatusen i `compose.ts`) står vakthunden, og
 *    svaret er DOWN. Negativ alder er klokkeavvik: UKJENT (aldri OK, aldri DOWN), fordi alderen ikke kan bevises.
 *  - `facts_seen` er antall sjekker som feilet i siste tikk; `last_status` `failed`/`skipped` betyr at selve registreringen feilet. Begge gir DEGRADED. Sjekkenes MELDINGSTEKST og `last_error` (ubetrodd tekst, regel 7) når aldri
 *    svaret - kun tall, tilstander og tidspunkt.
 *  - Uten rad, med ugyldige verdier eller ved lesefeil er svaret UKJENT. Ukjent er aldri «frisk».
 * Er incident-produsentene AV (standard), registreres ikke vakthundens tikk varig, og området forblir UKJENT med den årsaken.
 *
 * Vakthundens varige tilstand UAVHENGIG av hendelsesautomatikken (egen tabell/migrasjon) er bevisst utsatt (OPS2b, eierens valg).
 */
export const WATCHDOG_STALE_FACTOR = 3;
const SOURCE = "incident_producer_runs (producer=watchdog, skrevet av vakthundens tikk-bro i worker)";
export const WATCHDOG_PRODUCERS_OFF_DETAIL = "incident-produsentene er AV: vakthundens tikk registreres ikke varig";
export const WATCHDOG_UNREADABLE_DETAIL = "Vakthundens registrerte tikk kunne ikke leses fra databasen - jeg vet ikke om vakthunden tikker.";
const KNOWN_STATUS: ReadonlySet<string> = new Set(["running", "ok", "failed", "skipped"]);

/** Kun feltene leseren trenger fra `ProducerRunRow` (`last_started_at` er en `Date` fra pg, eller en ISO-streng). */
export interface WatchdogRunRow {
  last_started_at: string | Date;
  last_status: string;
  facts_seen: number;
  consecutive_failures: number;
}

/** Den injiserte kilden (`SelfModelReaderDeps.watchdogRuns`): raden (eller null) og produsent-intervallet grensen regnes av. */
export interface WatchdogRunSource {
  read: () => Promise<WatchdogRunRow | null>;
  intervalMs: number;
}

/** Leser `watchdog`-raden for én tenant via den eksisterende `ProducerRunStore.list` (kun lesing under RLS). */
export function watchdogRunSource(store: Pick<ProducerRunStore, "list">, tenantId: string, intervalMs: number): WatchdogRunSource {
  return {
    intervalMs,
    read: async () => (await store.list(tenantId)).find((r) => r.producer === "watchdog") ?? null
  };
}

const nb1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1).replace(".", ",");
function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min`;
  const h = m / 60;
  return h < 48 ? `${nb1(h)} t` : `${nb1(h / 24)} d`;
}
const unknown = (detail: string): Observation => ({ status: "UNKNOWN", source: SOURCE, observed_at: null, detail });
const validCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * REN funksjon: raden + klokken + produsent-intervallet gir en observasjon. Ingen I/O, ingen skjulte avhengigheter - grenser og kombinasjoner er testet i `wpops2a-watchdog-reader.test.ts`.
 * Rekkefølgen er bevisst: ukjent/ugyldig FØR alt annet (aldri en gjetning), så DOWN (står) FØR DEGRADED (en vakthund som står kan ikke si hva som feiler nå).
 */
export function observeWatchdogRun(row: WatchdogRunRow | null, now: Date, intervalMs: number): Observation {
  if (row === null) return unknown("Ingen vakthund-tikk er registrert ennå (worker har ikke tikket siden incident-produsentene ble slått på, eller worker kjører ikke).");
  if (!(Number.isFinite(intervalMs) && intervalMs > 0)) return unknown("Vakthundens forventede tikk-intervall er ugyldig - alderen kan ikke vurderes.");
  const startedMs = new Date(row.last_started_at).getTime();
  if (!Number.isFinite(startedMs)) return unknown("Vakthundens siste registrerte tikk har et ugyldig tidspunkt.");
  if (!KNOWN_STATUS.has(row.last_status) || !validCount(row.facts_seen) || !validCount(row.consecutive_failures)) return unknown("Vakthundens registrerte tikk har uventede verdier - jeg tolker dem ikke.");
  const ageMs = now.getTime() - startedMs;
  if (ageMs < 0) return unknown("Vakthundens siste tikk er datert frem i tid (klokkeavvik mellom worker og API) - alderen kan ikke bevises.");

  const limitMs = WATCHDOG_STALE_FACTOR * intervalMs;
  const observedAt = new Date(startedMs).toISOString();
  const data = { age_s: Math.round(ageMs / 1000), failing_checks: row.facts_seen, consecutive_failures: row.consecutive_failures };
  if (ageMs > limitMs) {
    return { status: "DOWN", source: SOURCE, observed_at: observedAt, detail: `Vakthunden har ikke tikket på ${fmtAge(ageMs)} (grensen er ${fmtAge(limitMs)}) - worker står, henger eller er stoppet.`, data };
  }
  const reasons: string[] = [];
  if (row.last_status === "failed") reasons.push(`siste registrering av tikket feilet${row.consecutive_failures > 0 ? ` (${row.consecutive_failures} på rad)` : ""}`);
  if (row.last_status === "skipped") reasons.push("siste registrering av tikket ble hoppet over");
  if (row.facts_seen > 0) reasons.push(`${row.facts_seen} ${row.facts_seen === 1 ? "sjekk" : "sjekker"} feiler`);
  if (reasons.length > 0) {
    return { status: "DEGRADED", source: SOURCE, observed_at: observedAt, detail: `Vakthunden tikket for ${fmtAge(ageMs)} siden, men ${reasons.join("; ")}.`, data };
  }
  return { status: "OK", source: SOURCE, observed_at: observedAt, detail: `Vakthunden tikket for ${fmtAge(ageMs)} siden; ingen sjekker feiler.`, data };
}

/** Selve leseren: kilde -> observasjon. Lesefeil gir UKJENT med FAST tekst (feilteksten kan bære hemmeligheter og siteres aldri). */
export async function readWatchdogObservation(source: WatchdogRunSource | undefined, now: Date): Promise<Observation> {
  if (source === undefined) return unknown(WATCHDOG_PRODUCERS_OFF_DETAIL);
  let row: WatchdogRunRow | null;
  try {
    row = await source.read();
  } catch {
    return unknown(WATCHDOG_UNREADABLE_DETAIL);
  }
  return observeWatchdogRun(row, now, source.intervalMs);
}
