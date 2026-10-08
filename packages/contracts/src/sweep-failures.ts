/**
 * D-442 (JARVIS-027): daglige per-tenant-sveip isolerer feil per tenant (én tenant skal aldri velte de andre), men isolasjonen svelget
 * også feilen: 13 av 19 jobber kastet resultatet i `main.ts` (`.then(() => undefined)`), så `DailyScheduler` bokførte dagen som fullført
 * selv om en tenant ikke ble behandlet - ingen ny forsøk, ingen `last_error`, bare en logglinje som ingen leser.
 *
 * Mønster: sveipet tar en VALGFRI `SweepFailureCollector` som siste parameter og registrerer hver per-tenant-feil der (isolasjonen er
 * uendret - resten av tenantene kjører fortsatt, og den eksisterende `*_failed`-logglinjen står). `failOnSweepFailures()` kjører sveipet og
 * KASTER først etterpå hvis noe ble registrert, slik at `DailyScheduler` kaller `markFailed()`: nytt forsøk etter 1/5/15 minutter (maks 4
 * forsøk per dag), `scheduler_state.last_error` lagres, og `daily_scheduler_gave_up` logges når forsøkene er brukt opp.
 *
 * VIKTIG - retry kjører HELE sveipet på nytt for ALLE tenants. Bruk derfor kun denne mekanismen for sveip som er idempotente (upsert/dedup-
 * nøkler, ingen utgående meldinger). Sveip som leverer meldinger (for eksempel ukentlig brief, der idempotensnøkkelen inneholder
 * `generated_at`) må vurdere retry-konsekvensen selv - se kallestedet i `apps/api/src/main.ts`.
 */
export interface SweepFailure {
  tenant_id: string;
  /** Delmengde når feilen ikke gjelder hele tenanten (memory space, samtykke, konto, kort, delsteg). */
  scope?: string;
  error: string;
}

/** Strukturelt kompatibel med de `failed[]`-listene som retensjons-/minnesveipene allerede returnerer. */
export interface SweepFailureLike {
  tenant_id: string;
  error: string;
  memory_space_id?: string;
  scope?: string;
}

const MAX_ERROR_CHARS = 120;
const SHOWN_FAILURES = 3;

export function describeSweepError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
}

export class SweepFailureCollector {
  private readonly recorded: SweepFailure[] = [];

  record(tenantId: string, err: unknown, scope?: string): void {
    this.recorded.push({ tenant_id: tenantId, ...(scope === undefined ? {} : { scope }), error: describeSweepError(err) });
  }

  get failures(): readonly SweepFailure[] {
    return this.recorded;
  }
}

function summarize(job: string, failures: readonly SweepFailure[]): string {
  const shown = failures.slice(0, SHOWN_FAILURES).map((f) => `${f.tenant_id}${f.scope ? `/${f.scope}` : ""}: ${f.error}`);
  const rest = failures.length - shown.length;
  return `${job}: ${failures.length} tenant-feil (${shown.join("; ")}${rest > 0 ? `; +${rest} til` : ""})`;
}

export class SweepFailedError extends Error {
  constructor(readonly job: string, readonly failures: readonly SweepFailure[]) {
    super(summarize(job, failures));
    this.name = "SweepFailedError";
  }
}

/** Kaster `SweepFailedError` hvis listen ikke er tom. For sveip som allerede returnerer en `failed[]`-liste. */
export function assertNoSweepFailures(job: string, failures: readonly SweepFailureLike[]): void {
  if (failures.length === 0) return;
  throw new SweepFailedError(
    job,
    failures.map((f) => {
      const scope = f.scope ?? f.memory_space_id;
      return { tenant_id: f.tenant_id, ...(scope === undefined ? {} : { scope }), error: f.error };
    })
  );
}

/** Kjører sveipet med en samler og kaster ETTER at alle tenants er forsøkt hvis noen feilet (resultatet forkastes - jobben har ingen konsument). */
export async function failOnSweepFailures(job: string, run: (failures: SweepFailureCollector) => Promise<unknown>): Promise<void> {
  const failures = new SweepFailureCollector();
  await run(failures);
  assertNoSweepFailures(job, failures.failures);
}
