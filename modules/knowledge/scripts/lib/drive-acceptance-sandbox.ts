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
export class DriveAcceptanceSandbox {
  readonly rootId: string;
  readonly autoCreated: boolean;
  private readonly created: string[] = [];
  private readonly known: Set<string>;

  constructor(rootId: string, autoCreated: boolean) {
    this.rootId = rootId;
    this.autoCreated = autoCreated;
    this.known = new Set([rootId]);
  }

  /** Kalles ETTER et vellykket create_file/create_folder-kall - fra NÅ AV er denne IDen et gyldig mutasjonsmål. */
  trackCreated(id: string): void {
    this.created.push(id);
    this.known.add(id);
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

  /**
   * Rekkefølge for opprydding: barn FØRST (sist opprettet slettes først -
   * trygt for undermapper-i-undermapper), roten SIST - og KUN hvis DENNE
   * kjøringen selv opprettet den (`autoCreated`). En eksplisitt konfigurert
   * `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` slettes ALDRI av runneren - Tobias
   * sin egen mappe er hans å administrere, ikke runnerens.
   */
  cleanupTargets(): string[] {
    const children = [...this.created].reverse();
    return this.autoCreated ? [...children, this.rootId] : children;
  }
}
