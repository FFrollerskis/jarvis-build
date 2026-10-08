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

/**
 * Avslagsårsaker fra `ToolGateway`/`PolicyGateway` som betyr at EIEREN bevisst har stoppet noe (frosset tilkobling, tilbakekalt credential, kill switch). Et nytt forsøk kan
 * ikke og SKAL ikke omgå dem, og en jobb som respekterer en pause har ikke feilet - den hoppes over (registreres som `skipped`, ikke som feil).
 */
const DELIBERATE_PAUSE_REASONS = ["connector_frozen", "credential_revoked", "kill_switch_active"] as const;

export function isDeliberatePause(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return DELIBERATE_PAUSE_REASONS.some((reason) => text.includes(reason));
}

export class SweepFailureCollector {
  private readonly recorded: SweepFailure[] = [];
  private readonly skippedByPause: SweepFailure[] = [];

  record(tenantId: string, err: unknown, scope?: string): void {
    const entry: SweepFailure = { tenant_id: tenantId, ...(scope === undefined ? {} : { scope }), error: describeSweepError(err) };
    if (isDeliberatePause(err)) this.skippedByPause.push(entry);
    else this.recorded.push(entry);
  }

  get failures(): readonly SweepFailure[] {
    return this.recorded;
  }

  /** Tenants/delsteg som ble hoppet over fordi eieren har pauset dem (frysing, tilbakekalling, kill switch). Gir aldri nytt forsøk. */
  get skipped(): readonly SweepFailure[] {
    return this.skippedByPause;
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
  if (failures.skipped.length > 0) {
    // Eieren har pauset noe (frysing/tilbakekalling/kill switch): jobben respekterer det og hopper over - synlig i loggen, men ikke en feil og aldri et nytt forsøk.
    console.log(JSON.stringify({ msg: "sweep_skipped_owner_pause", job, skipped: failures.skipped.length, first: failures.skipped[0]?.error }));
  }
  assertNoSweepFailures(job, failures.failures);
}
