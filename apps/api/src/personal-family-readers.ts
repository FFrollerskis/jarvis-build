import type { SharedDataReaders } from "@jarvis/context";

/**
 * WP-G2 (D-464, UA-8) P1c: lesere som gir det AVLEDEDE innholdet i en delt kategori fra subjektets EGEN datatenant (se `SharedDataReaders` i `@jarvis/context`). Kalles KUN etter at `FamilyService.readShared` har bevist en aktiv
 * deling fra subjektet, at seer-rollen tillater kategorien og at subjektet fortsatt er medlem av datatenanten. Lesernes jobb er MINIMERING: de returnerer aldri koordinater, nøyaktige tidspunkt for hver måling eller råverdier -
 * kun sonenavnet personen er i nå, og to aggregater (skritt i dag, søvn siste natt). Strukturelle grensesnitt (ikke de konkrete tjenestene) slik at de kan testes uten database; `LocationService`/`HealthService` oppfyller dem.
 */
export interface LocationReadApi {
  listZoneVisits(tenantId: string, memorySpace: "personal", personId: string, filter: { open_only: boolean }): Promise<Array<{ zone_id: string; entered_at: unknown }>>;
  getZone(tenantId: string, memorySpace: "personal", zoneId: string): Promise<{ name: string } | null>;
  /** Personens siste posisjonsobservasjon. KUN `observed_at` leses (ferskhet): koordinatene brukes aldri og forlater aldri leseren (WP-G2c, JARVIS-113 e/5). */
  getPersonLocation(tenantId: string, memorySpace: "personal", personId: string): Promise<{ observed_at: unknown } | null>;
}

export interface HealthReadApi {
  getRecentMetrics(tenantId: string, personId: string, metricType?: "steps" | "sleep_duration_minutes", sinceMs?: number): Promise<Array<{ metric_type: string; value: unknown; observed_at: unknown }>>;
}

export interface FamilyReaderOptions {
  location: LocationReadApi;
  health: HealthReadApi;
  /** IANA-tidssone for «i dag» (standard `Europe/Oslo`). */
  timeZone?: string;
  now?: () => Date;
  /** Høyeste alder på personens siste posisjonsobservasjon for at «nå»-stedet vises (standard `PLACE_MAX_AGE_MS`). Ugyldig verdi (ikke et positivt heltall) = standarden, aldri «ingen grense». */
  placeMaxAgeMs?: number;
}

const HOUR = 3_600_000;
/**
 * «Nå»-stedet er sonen i personens åpne sonebesøk, og et besøk lukkes KUN av en NY observasjon utenfor sonen: slutter telefonen å melde (tomt batteri, avskrudd, tilgang trukket), står besøket åpent for alltid og familien ville sett «Hjemme» i
 * dagevis. Stedet vises derfor bare når personens SISTE observasjon (ikke besøkets starttidspunkt: en lang natt hjemme er et gyldig besøk) er høyst så gammel; ellers er stedet «ukjent» (`null`), aldri et gammelt sted som om det var nå. 6 timer er en
 * bevisst forsiktig standard (feil side er «ukjent», ikke et feil sted); produsenten (iPhone-appen, `BLOCKED_EXTERNAL`) må melde oftere enn dette for at stedet skal vises (Q-G2c-3).
 */
export const PLACE_MAX_AGE_MS = 6 * HOUR;
/** En observasjon som er mer enn dette frem i tid er en klokkefeil og gir «ukjent» (fail closed): den ville ellers holdt stedet «ferskt» i timevis. */
const PLACE_MAX_FUTURE_SKEW_MS = 10 * 60_000;
/** Søvn «siste natt» = nyeste søvnmåling de siste 36 timene (en natt som endte i går morges er fortsatt «siste natt» sent på kvelden). */
const SLEEP_LOOKBACK_MS = 36 * HOUR;

const iso = (v: unknown): string | null => {
  const t = v instanceof Date ? v.getTime() : typeof v === "string" || typeof v === "number" ? Date.parse(String(v)) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** `numeric`-kolonner kommer fra pg som STRENGER (ingen type-parser er satt): tall og rene desimalstrenger godtas, alt annet forkastes (aldri en gjetting). */
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
};

function samples(rows: Array<{ value: unknown; observed_at: unknown }>): Array<{ value: number; at: string | null }> {
  return rows.flatMap((r) => {
    const value = num(r.value);
    return value === null ? [] : [{ value, at: iso(r.observed_at) }];
  });
}

function localParts(at: Date, timeZone: string): { year: number; month: number; day: number; asUtc: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at).map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const [year, month, day] = [Number(parts["year"]), Number(parts["month"]), Number(parts["day"])] as [number, number, number];
  return { year, month, day, asUtc: Date.UTC(year, month - 1, day, Number(parts["hour"]), Number(parts["minute"]), Number(parts["second"])) };
}

/** Lokal tid minus UTC (ms) i tidssonen på det gitte tidspunktet. */
function tzOffsetMs(at: Date, timeZone: string): number {
  return localParts(at, timeZone).asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Millisekunder (UTC-epoke) for lokal midnatt i tidssonen - brukes til «skritt i dag». Forskyvningen måles på selve midnatts-tidspunktet (andre runde), ikke på «nå»: på dagen sommertid begynner/slutter er
 * forskyvningen ved midnatt en annen enn nå-forskyvningen.
 */
export function startOfLocalDayMs(now: Date, timeZone: string): number {
  const { year, month, day } = localParts(now, timeZone);
  const midnightAsUtc = Date.UTC(year, month - 1, day);
  const firstGuess = midnightAsUtc - tzOffsetMs(now, timeZone);
  return midnightAsUtc - tzOffsetMs(new Date(firstGuess), timeZone);
}

export function familySharedDataReaders(options: FamilyReaderOptions): SharedDataReaders {
  const timeZone = options.timeZone ?? "Europe/Oslo";
  const now = options.now ?? (() => new Date());
  const maxAge = typeof options.placeMaxAgeMs === "number" && Number.isInteger(options.placeMaxAgeMs) && options.placeMaxAgeMs >= 1 ? options.placeMaxAgeMs : PLACE_MAX_AGE_MS;
  return {
    async currentPlace(dataTenantId, personId) {
      // Sted = NAVNET på sonen personen er i nå (åpent sonebesøk). Aldri koordinater; ingen åpen sone = null (ukjent sted, ikke «hjemme»/«borte»).
      const visits = await options.location.listZoneVisits(dataTenantId, "personal", personId, { open_only: true });
      const visit = visits[0];
      if (visit === undefined) return null;
      // FERSKHET (WP-G2c, JARVIS-113 e/5): se `PLACE_MAX_AGE_MS`. Ingen observasjon, en ulesbar eller en fremtidig (klokkefeil) = ukjent. `observed_at` er NÅ tidspunktet personen sist ble sett, ikke når besøket begynte.
      const last = await options.location.getPersonLocation(dataTenantId, "personal", personId);
      const lastSeen = last === null ? null : iso(last.observed_at);
      if (lastSeen === null) return null;
      const age = now().getTime() - Date.parse(lastSeen);
      if (age > maxAge || age < -PLACE_MAX_FUTURE_SKEW_MS) return null;
      const zone = await options.location.getZone(dataTenantId, "personal", visit.zone_id);
      return zone === null ? null : { zone_name: zone.name, observed_at: lastSeen };
    },
    async healthSummary(dataTenantId, personId) {
      const current = now();
      const dayStart = startOfLocalDayMs(current, timeZone);
      const steps = samples(await options.health.getRecentMetrics(dataTenantId, personId, "steps", dayStart));
      const sleepSamples = samples(await options.health.getRecentMetrics(dataTenantId, personId, "sleep_duration_minutes", current.getTime() - SLEEP_LOOKBACK_MS));
      const sleep = sleepSamples.slice().sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0];
      if (steps.length === 0 && sleep === undefined) return null;
      const observed = [...steps, ...(sleep ? [sleep] : [])].map((s) => s.at).filter((v): v is string => v !== null).sort();
      return {
        // Skritt: sum av dagens målinger (ingen måling = null, aldri 0). Søvn: nyeste søvnmåling (minutter), avrundet.
        // MERK (JARVIS-113 e/5, DEFERRED): summen forutsetter at appen sender HealthKits DEDUPLISERTE skritt (statistikk i lukkede intervaller). Rå prøver fra både iPhone og Watch overlapper og telles da dobbelt; serveren kan ikke
        // se det (prøven bærer bare `observed_at`, ikke start/slutt eller HealthKit-kilde). Se kontrakten i `modules/health/src/intake.ts` og `docs/runbooks/WPG2_PERSONAL.md` §12.
        steps_today: steps.length === 0 ? null : Math.round(steps.reduce((sum, s) => sum + s.value, 0)),
        sleep_minutes_last_night: sleep === undefined ? null : Math.round(sleep.value),
        observed_at: observed.length === 0 ? null : (observed[observed.length - 1] as string)
      };
    }
  };
}
