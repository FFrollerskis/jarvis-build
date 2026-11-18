/**
 * WP-G2 P1b (D-464, UA-8): `CarAdapter` - den leverandørnøytrale PORTEN for bilen (CLAUDE.md regel 3: alle leverandører bak adaptere; regel 12/D-64: Jarvis eier handlingsmodellen, journalen og policyen - bilen/leverandøren er
 * en utfører og kilde til nåtilstand, `EXTERNAL_CANONICAL`). INGEN leverandør er valgt: eierens bilmerke/konto er ukjent, og et aggregat-API (Smartcar/Enode-typen) ville blitt en KJERNEAVHENGIGHET i bilens handlingsvei - det er en
 * D-64-port som kun Tobias kan passere (`CORE_DEPENDENCY_DECISION_REQUIRED` hvis han velger et aggregat). Live er derfor `BLOCKED_EXTERNAL`; denne filen er kontrakten, `UnconfiguredCarAdapter` (fail-closed) og typene.
 * Test-dobbelen (`FakeCarAdapter`) ligger under `test/support/` - ikke i produksjonsflaten (D-396-vakten).
 *
 * KONTRAKTEN (en fremtidig ekte adapter MÅ oppfylle den; `test/support/car-adapter-contract.ts` er kontraktstesten):
 *  - `readState()` gir en NORMALISERT tilstand (aldri leverandørens rå nyttelast, aldri posisjon/GPS, aldri fritekst) og `fresh: true` KUN når leverandøren sier at tilstanden er levende (ikke bufret/sist kjente). En bufret tilstand skal
 *    ALDRI kunne verifisere en kommando - derfor er etterbetingelsene bygget på `fresh`. Ukjent kjøretøy = `null` (aldri kast, aldri en gjettet tilstand).
 *  - `command()` returnerer når leverandøren har AKSEPTERT kommandoen - ikke når bilen har utført den (biler vekkes og svarer sakte). Utførelsen bevises av readback, aldri av «akseptert».
 *  - Feil kastes som `CarAdapterError` med `outcomeKnown`: `true` = kommandoen nådde ALDRI leverandøren/ble entydig avvist (ingen bivirkning, retry tillatt); `false` = kommandoen KAN ha nådd leverandøren (tidsavbrudd, nullstilt
 *    forbindelse, 5xx) - utfallet er UKJENT og samme nøkkel gir aldri en ny kommando. Adapteren vet dette; gatewayen kan ikke gjette det.
 *  - Kjøretøy-id er et OPAKT Jarvis-alias (`bil`, `elbil-1`) som adapteren selv mapper til leverandørens id: VIN og leverandør-id-er er personopplysninger og står aldri i allowlist, journal eller varsel.
 *  - Adapteren leser sine egne credentials via vault-referanser; ingen hemmelighet passerer kontrakten.
 */
export const CAR_CAPABILITIES = ["lock_state", "lock_set", "climate_state", "climate_set", "charge_state", "charge_set"] as const;
export type CarCapability = (typeof CAR_CAPABILITIES)[number];

export type CarLockState = "locked" | "unlocked" | "unknown";
export type CarClimateState = "on" | "off" | "unknown";
export type CarChargeState = "charging" | "stopped" | "complete" | "disconnected" | "unknown";

/** Normalisert, redigert kjøretøytilstand. Ingen posisjon, ingen VIN, ingen fritekst. */
export interface CarState {
  vehicle_id: string;
  /** Bilen svarer (våken/online). `false` er ikke en feil - en adapter kan vekke den ved kommando - men readback krever `fresh`. */
  reachable: boolean;
  lock: CarLockState;
  climate: CarClimateState;
  charging: CarChargeState;
  /** Ladenivå 0-100, eller `null` (ukjent/ikke elektrisk). */
  charge_percent: number | null;
  /** Leverandøren sier at denne tilstanden er LEVENDE (ikke bufret). Påkrevd for at en etterbetingelse skal kunne verifiseres. */
  fresh: boolean;
  /** ISO-tidsstempel for når leverandøren målte tilstanden, eller `null`. */
  observed_at: string | null;
}

export type CarCommand = { kind: "lock" } | { kind: "unlock" } | { kind: "climate_start" } | { kind: "climate_stop" } | { kind: "charge_start" } | { kind: "charge_stop" };

export interface CarCallContext {
  /** Avbruddssignal (gatewayens frist). Adapteren skal ikke sende noe nytt etter at det er avbrutt. */
  signal?: AbortSignal | undefined;
}

export interface CarCommandContext extends CarCallContext {
  /** Gatewayens idempotensnøkkel. En adapter hvis leverandør støtter idempotensnøkkel skal sende den videre. */
  idempotencyKey: string;
}

export interface CarCommandResult {
  accepted: boolean;
  /** Leverandørens egen referanse for kommandoen (ikke hemmelig; vises i journalens `external_id`). */
  command_ref?: string;
}

export interface CarAdapter {
  readonly name: string;
  /** Hvilke kapabiliteter denne konkrete adapteren faktisk støtter (D-41: ærlig, aldri overdrevet). */
  readonly capabilities: readonly CarCapability[];
  readState(vehicleId: string, context?: CarCallContext): Promise<CarState | null>;
  command(vehicleId: string, command: CarCommand, context: CarCommandContext): Promise<CarCommandResult>;
}

export const CAR_ERROR_CODES = ["car_provider_not_configured", "car_vehicle_unknown", "car_unauthorized", "car_rejected", "car_rate_limited", "car_not_supported", "car_unreachable", "car_unavailable"] as const;
export type CarErrorCode = (typeof CAR_ERROR_CODES)[number];

export class CarAdapterError extends Error {
  /** `true` = kommandoen nådde aldri leverandøren / ble entydig avvist (ingen bivirkning). `false` = utfallet er UKJENT. */
  constructor(readonly code: CarErrorCode, readonly outcomeKnown: boolean) {
    super(code);
    this.name = "CarAdapterError";
  }
}

/**
 * Standardadapteren når `JARVIS_PERSONAL_CAR=on` men INGEN leverandør er valgt/koblet (D-64-porten er ikke passert): hver lesing og kommando feiler lukket og tydelig. Ingenting sendes noe sted.
 * (Navnet unngår `Fake*`/`Mock*`/`InMemory*`: dette er produksjonsflatens eksplisitte «ikke konfigurert»-adapter, ikke en test-dobbel.)
 */
export class UnconfiguredCarAdapter implements CarAdapter {
  readonly name = "unconfigured";
  readonly capabilities: readonly CarCapability[] = [];
  async readState(): Promise<CarState | null> {
    throw new CarAdapterError("car_provider_not_configured", true);
  }
  async command(): Promise<CarCommandResult> {
    throw new CarAdapterError("car_provider_not_configured", true);
  }
}

/** En tilstand eldre enn dette regnes ikke som «nåtilstand» uansett hva adapteren påstår (en adapter som bufrer lenger skal sette `fresh: false`). */
export const CAR_MAX_STATE_AGE_MS = 30 * 60_000;

/**
 * Streng normalisering av en adapters svar: ukjente/ugyldige verdier blir `unknown`/`null` (aldri en gjettet verdi), ladenivå utenfor 0-100 blir `null`. Brukes av transporten på ALT en adapter returnerer.
 * `fresh` er `true` KUN når adapteren sier det OG tidsstemplet (hvis det finnes) ikke er eldre enn `CAR_MAX_STATE_AGE_MS` (og ikke i fremtiden utover 5 min): en adapter kan ikke «forfriske» en gammel tilstand ved å påstå det.
 */
export function normalizeCarState(vehicleId: string, raw: Partial<Record<keyof CarState, unknown>> | null, nowMs: number = Date.now()): CarState | null {
  if (raw === null) return null;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);
  const percent = raw.charge_percent;
  const observed = typeof raw.observed_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw.observed_at) && Number.isFinite(Date.parse(raw.observed_at)) ? raw.observed_at.slice(0, 40) : null;
  const observedMs = observed === null ? null : Date.parse(observed);
  const ageOk = observedMs === null || (nowMs - observedMs <= CAR_MAX_STATE_AGE_MS && observedMs - nowMs <= 5 * 60_000);
  return {
    vehicle_id: vehicleId, reachable: raw.reachable === true, lock: pick(raw.lock, ["locked", "unlocked"] as const, "unknown"), climate: pick(raw.climate, ["on", "off"] as const, "unknown"),
    charging: pick(raw.charging, ["charging", "stopped", "complete", "disconnected"] as const, "unknown"),
    charge_percent: typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null, fresh: raw.fresh === true && ageOk, observed_at: observed
  };
}
