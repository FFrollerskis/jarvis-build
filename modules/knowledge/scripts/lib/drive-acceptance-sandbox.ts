// UA-2 P1A HOST RECOVERY (2026-08-16) - "auto-create safe Drive test
// sandbox": Tobias skal ALDRI måtte manuelt opprette en Drive-testmappe,
// finne/kopiere en mappe-ID, eller redigere .env for å kjøre P1A sin
// Google Drive-akseptanse. Denne fila er BEVISST ren, avhengighetsfri
// bokføring/regelsjekk (INGEN fetch/nettverk her) - selve
// opprettelsen/mutasjonene skjer i ua2-p1a-live.ts via den eksisterende
// ToolGateway/GoogleDriveTransport-veien; denne fila gjør grensekontrollen
// og cleanup-scopingen deterministisk testbar uten en ekte Drive-tilkobling.

/**
 * Navnet en auto-opprettet akseptanse-mappe får. UNIK per kjøring (via
 * runId) - runneren SKAL ALDRI søke etter en eksisterende mappe med
 * lignende navn og gjenbruke den (se ua2-p1a-live.ts: ingen `list_files`-
 * søk-etter-navn-kode finnes noe sted i akseptanse-flyten).
 */
export function driveAcceptanceFolderName(runId: string): string {
  return `Jarvis P1A Acceptance ${runId}`;
}

/**
 * Samme substring-baserte klassifisering som `classifyToolFailure` i
 * `@jarvis/knowledge` (source.ts) - IKKE duplisert logikk, kun en lokal,
 * avhengighetsfri kopi av AKKURAT det ua2-p1a-live.ts trenger for å skille
 * "token mangler write-scope" fra andre feiltyper, uten å dra inn hele
 * ToolGateway-typegrafen i denne rene fila.
 */
export function isReauthSignal(reason: string): boolean {
  return /auth_error_401|auth_error_403/.test(reason);
}

export type TestRootSource = "configured" | "auto_created";

/**
 * Ren beslutningsregel (§1 i host-recovery-ordren): en eksplisitt konfigurert
 * `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` respekteres ALLTID - runneren
 * auto-oppretter KUN når variabelen faktisk mangler (tom streng regnes som
 * "ikke satt", samme konvensjon som resten av env-lesingen i denne fila).
 */
export function determineTestRootSource(configuredFolderId: string | undefined): TestRootSource {
  return configuredFolderId ? "configured" : "auto_created";
}

export class DriveBoundaryViolationError extends Error {
  constructor(fileId: string) {
    super(`drive_acceptance_boundary_violation: ${fileId} er ikke et kjent artefakt av denne akseptansekjøringens sandkasse`);
    this.name = "DriveBoundaryViolationError";
  }
}

/**
 * Sporer AKKURAT hvilke Drive-objekter denne akseptansekjøringen selv har
 * opprettet, eller fikk oppgitt som en eksplisitt konfigurert test-rot.
 * `assertInSandbox()` er den ENESTE veien en mutasjon godkjennes - et objekt
 * som IKKE eksplisitt er sporet blir ALDRI mutert, uansett hvor det kom fra
 * (fail-closed grensekontroll, se §3 i host-recovery-ordren).
 */
/**
 * HOST FIX #8 (2026-08-16, host-funn run_id ff16c69d): eksplisitt
 * artefakt-livssyklus. `PERMANENTLY_DELETED`/`CLEANED` er begge "borte for
 * godt"-tilstander som ALDRI skal forsøkes slettet på nytt -
 * `cleanupTargets()` under utelater dem strukturelt. Skillet mellom de to:
 * `PERMANENTLY_DELETED` settes av en EKSPLISITT `delete_permanent`-
 * akseptansetest (f.eks. §P i ua2-p1a-live.ts, som beviser selve
 * handlingen), mens `CLEANED` settes av selve §5-oppryddingsfasen (enten en
 * fersk sletting DER, eller et allerede-borte-funn klassifisert trygt av
 * `classifyCleanupOutcome()`).
 */
export type DriveArtifactState = "CREATED" | "TRASHED" | "PERMANENTLY_DELETED" | "CLEANED";

const TERMINAL_STATES: ReadonlySet<DriveArtifactState> = new Set(["PERMANENTLY_DELETED", "CLEANED"]);

export class DriveAcceptanceSandbox {
  readonly rootId: string;
  readonly autoCreated: boolean;
  private readonly created: string[] = [];
  private readonly known: Set<string>;
  private readonly states = new Map<string, DriveArtifactState>();

  constructor(rootId: string, autoCreated: boolean) {
    this.rootId = rootId;
    this.autoCreated = autoCreated;
    this.known = new Set([rootId]);
  }

  /** Kalles ETTER et vellykket create_file/create_folder-kall - fra NÅ AV er denne IDen et gyldig mutasjonsmål. */
  trackCreated(id: string): void {
    this.created.push(id);
    this.known.add(id);
    this.states.set(id, "CREATED");
  }

  has(id: string): boolean {
    return this.known.has(id);
  }

  /** Kastes FØR ethvert mutasjonskall (update/rename/move/trash/delete_permanent) - fail-closed, aldri "prøv og se". */
  assertInSandbox(id: string): void {
    if (!this.known.has(id)) {
      throw new DriveBoundaryViolationError(id);
    }
  }

  /** Kun artefaktene DENNE kjøringen selv opprettet - ALDRI roten hvis den var eksplisitt konfigurert (Tobias sin egen mappe). */
  createdArtifactIds(): readonly string[] {
    return this.created;
  }

  /** Nåværende livssyklustilstand for et SPORT artefakt - `undefined` for et helt usporet ID (aldri kastet, kun en ren oppslag). */
  stateOf(id: string): DriveArtifactState | undefined {
    return this.states.get(id);
  }

  /** §O i ua2-p1a-live.ts: reversibel - påvirker ALDRI cleanupTargets() (et trashet, men ikke permanent slettet artefakt skal fortsatt ryddes normalt). Usporet ID -> no-op, aldri en krasj. */
  markTrashed(id: string): void {
    if (this.states.has(id)) this.states.set(id, "TRASHED");
  }

  /** §P i ua2-p1a-live.ts: kalles KUN etter en FAKTISK vellykket delete_permanent-akseptansetest - fra NÅ AV utelates denne IDen fra cleanupTargets() (HOST FIX #8 §2: aldri et redundant slettingsforsøk mot et artefakt vi VET allerede er borte). Usporet ID -> no-op, aldri en krasj. */
  markPermanentlyDeleted(id: string): void {
    if (this.states.has(id)) this.states.set(id, "PERMANENTLY_DELETED");
  }

  /** §5-oppryddingsfasen i ua2-p1a-live.ts: settes for ETHVERT artefakt cleanup-løkka selv har håndtert (fersk sletting ELLER et trygt already_absent-funn) - utelater det fra en EVENTUELL fremtidig gjentatt cleanupTargets()-beregning (§M: gjentatt opprydding er idempotent). Usporet ID -> no-op, aldri en krasj. */
  markCleaned(id: string): void {
    if (this.states.has(id)) this.states.set(id, "CLEANED");
  }

  /**
   * Rekkefølge for opprydding: barn FØRST (sist opprettet slettes først -
   * trygt for undermapper-i-undermapper), roten SIST - og KUN hvis DENNE
   * kjøringen selv opprettet den (`autoCreated`). En eksplisitt konfigurert
   * `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` slettes ALDRI av runneren - Tobias
   * sin egen mappe er hans å administrere, ikke runnerens. HOST FIX #8: et
   * barn i en TERMINAL tilstand (`PERMANENTLY_DELETED`/`CLEANED`) utelates
   * HELT - cleanup skal ALDRI forsøke å slette noe vi allerede vet er borte
   * (root-funn: dette var NØYAKTIG årsaken til `google_drive_cleanup=FAIL`
   * på run_id ff16c69d - §P sin allerede-vellykkede permanente sletting av
   * hovedtestfila ble forsøkt SLETTET PÅ NYTT av §5, og Drive sin 404 der
   * traff class-D sin preflight-sjekk FØR selve delete_permanent-transportens
   * egen (allerede idempotente) 404-håndtering noensinne ble nådd).
   */
  cleanupTargets(): string[] {
    const children = [...this.created].reverse().filter((id) => !TERMINAL_STATES.has(this.states.get(id) as DriveArtifactState));
    return this.autoCreated ? [...children, this.rootId] : children;
  }
}

/**
 * HOST FIX #8 §1/§2 (2026-08-16): gjenkjenner BEGGE formene en Drive-404 kan
 * komme tilbake som gjennom ToolGateway - direkte fra selve transportkallet
 * (`tool_failed:drive_not_found_<id>`), ELLER via klasse-D sin
 * preflight-sjekk (`preflight_failed:drive_not_found_<id>` - se gateway.ts:
 * en klasse-D-handling leser nå-tilstanden MED `get_metadata` FØR selve
 * handlingen forsøkes; et allerede permanent slettet artefakt gir 404 DER,
 * FØR `deletePermanent()` sin egen idempotente 404-håndtering
 * (`already_deleted: "true"`) noensinne nås - dette er den FAKTISKE,
 * bekreftede (ikke gjettede) mekanismen bak run_id ff16c69d sin
 * `google_drive_cleanup=FAIL`).
 */
export function isNotFoundFailureReason(reason: string): boolean {
  return /drive_not_found_/.test(reason);
}

export type CleanupOutcome = "cleaned" | "already_absent" | "failed";

/**
 * HOST FIX #8 §2 (2026-08-16): klassifiserer ETT cleanup-forsøks utfall.
 * Et NOT_FOUND-svar telles KUN som "already_absent" når mål-IDen FAKTISK er
 * et KJENT sandkasse-artefakt (`sandbox.has()` - SAMME grensekontroll som
 * `assertInSandbox()` bruker for mutasjoner) - ALDRI generalisert til en
 * vilkårlig Drive-fil utenfor sandkassen. Selv om `cleanupTargets()`
 * strukturelt kun kan produsere kjente IDer i dag, holdes denne sjekken
 * eksplisitt her som et selvstendig, testbart sikkerhetsnett - samme
 * "fail-closed, ikke stille anta"-presedens som `assertInSandbox()` selv.
 * Enhver ANNEN feilårsak (rate-limit, auth, ukjent) klassifiseres ALDRI som
 * already_absent - kun en EKTE 404 for et sport artefakt teller.
 */
export function classifyCleanupOutcome(
  sandbox: Pick<DriveAcceptanceSandbox, "has">,
  targetId: string,
  deleteResult: { ok: boolean; reason?: string }
): CleanupOutcome {
  if (deleteResult.ok) return "cleaned";
  if (sandbox.has(targetId) && deleteResult.reason !== undefined && isNotFoundFailureReason(deleteResult.reason)) {
    return "already_absent";
  }
  return "failed";
}
