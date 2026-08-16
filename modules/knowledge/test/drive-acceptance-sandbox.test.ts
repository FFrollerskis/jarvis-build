import { describe, expect, it } from "vitest";
import {
  DriveAcceptanceSandbox,
  DriveBoundaryViolationError,
  classifyCleanupOutcome,
  determineTestRootSource,
  driveAcceptanceFolderName,
  isNotFoundFailureReason,
  isReauthSignal
} from "../scripts/lib/drive-acceptance-sandbox.ts";

/**
 * UA-2 P1A HOST RECOVERY (2026-08-16) §9: rene, deterministiske tester for
 * auto-create-beslutningen, sandkasse-grensekontrollen og cleanup-scopingen
 * som `ua2-p1a-live.ts` sin Google Drive-akseptanse bruker. INGEN nettverk/
 * Postgres nødvendig - dette er ren logikk.
 */
describe("determineTestRootSource (§A/§B)", () => {
  it("A: manglende konfigurert mappe-ID -> auto_created", () => {
    expect(determineTestRootSource(undefined)).toBe("auto_created");
    expect(determineTestRootSource("")).toBe("auto_created");
  });

  it("B: konfigurert mappe-ID -> configured (INGEN auto-opprettelse)", () => {
    expect(determineTestRootSource("folder-fra-tobias-123")).toBe("configured");
  });
});

describe("driveAcceptanceFolderName (§C/§D)", () => {
  it("C: navnet er UNIKT per kjøring (inkluderer run_id)", () => {
    const nameA = driveAcceptanceFolderName("run-aaaa1111");
    const nameB = driveAcceptanceFolderName("run-bbbb2222");
    expect(nameA).not.toBe(nameB);
    expect(nameA).toContain("run-aaaa1111");
    expect(nameB).toContain("run-bbbb2222");
  });

  it("D: navnet følger et fast, forutsigbart mønster (ingen skjult søk-og-gjenbruk-logikk et annet sted kan matche mot)", () => {
    expect(driveAcceptanceFolderName("xyz")).toBe("Jarvis P1A Acceptance xyz");
  });
});

describe("DriveAcceptanceSandbox - grensekontroll (§E/§F)", () => {
  it("E: roten selv og alt trackCreated() har registrert er GYLDIGE mutasjonsmål", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("child-1");
    sandbox.trackCreated("child-2");
    expect(() => sandbox.assertInSandbox("root-1")).not.toThrow();
    expect(() => sandbox.assertInSandbox("child-1")).not.toThrow();
    expect(() => sandbox.assertInSandbox("child-2")).not.toThrow();
    expect(sandbox.has("child-1")).toBe(true);
  });

  it("F: en ID som ALDRI ble sporet (utenfor sandkassen) nektes EKSPLISITT - fail-closed, ikke 'prøv og se'", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("child-1");
    expect(() => sandbox.assertInSandbox("noen-annen-tobias-fil-utenfor-sandkassen")).toThrow(DriveBoundaryViolationError);
    expect(sandbox.has("noen-annen-tobias-fil-utenfor-sandkassen")).toBe(false);
  });

  it("F: en tom sandkasse (ingenting opprettet ennå) nekter ALT unntatt roten selv", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", false);
    expect(() => sandbox.assertInSandbox("root-1")).not.toThrow();
    expect(() => sandbox.assertInSandbox("hva-som-helst-annet")).toThrow(DriveBoundaryViolationError);
  });
});

describe("isReauthSignal (§G)", () => {
  it("G: 401/403-mønstre klassifiseres som et reauth-signal", () => {
    expect(isReauthSignal("tool_failed:drive_auth_error_401")).toBe(true);
    expect(isReauthSignal("tool_failed:drive_auth_error_403")).toBe(true);
  });

  it("G: andre feiltyper (rate limit, not found, generisk) klassifiseres IKKE som reauth", () => {
    expect(isReauthSignal("tool_failed:drive_rate_limited")).toBe(false);
    expect(isReauthSignal("tool_failed:drive_not_found_x")).toBe(false);
    expect(isReauthSignal("tool_failed:drive_error_500")).toBe(false);
  });
});

describe("DriveAcceptanceSandbox - cleanup-scoping (§H/§I/§J)", () => {
  it("H/I: cleanupTargets() inneholder KUN artefakter DENNE kjøringen selv opprettet, barn FØR roten", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("child-a");
    sandbox.trackCreated("child-b");
    sandbox.trackCreated("subfolder-c");
    const targets = sandbox.cleanupTargets();
    // Barn ryddes FØR roten (siste opprettet -> først slettet):
    expect(targets).toEqual(["subfolder-c", "child-b", "child-a", "root-1"]);
  });

  it("I: en delvis oppsatt kjøring (kun NOEN artefakter faktisk opprettet før en feil) rydder KUN det som faktisk ble sporet", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("kun-denne-ble-opprettet");
    // Simulerer at resten av akseptansen feilet FØR flere artefakter ble opprettet:
    expect(sandbox.cleanupTargets()).toEqual(["kun-denne-ble-opprettet", "root-1"]);
    expect(sandbox.createdArtifactIds()).toEqual(["kun-denne-ble-opprettet"]);
  });

  it("J: en EKSPLISITT KONFIGURERT rot (autoCreated=false) er ALDRI i cleanup-listen - kun barna", () => {
    const sandbox = new DriveAcceptanceSandbox("tobias-sin-egen-mappe", false);
    sandbox.trackCreated("test-fil-1");
    sandbox.trackCreated("test-fil-2");
    const targets = sandbox.cleanupTargets();
    expect(targets).not.toContain("tobias-sin-egen-mappe");
    expect(targets).toEqual(["test-fil-2", "test-fil-1"]);
  });

  it("J: en helt tom kjøring mot en konfigurert rot rydder INGENTING (roten er aldri et mål)", () => {
    const sandbox = new DriveAcceptanceSandbox("tobias-sin-egen-mappe", false);
    expect(sandbox.cleanupTargets()).toEqual([]);
  });
});

/**
 * HOST FIX #8 "CLEANUP-ONLY BLOCKERS AFTER FULL DRIVE SUCCESS" (2026-08-16,
 * host-funn run_id ff16c69d): `google_drive_cleanup=FAIL` (targets=5,
 * root_deleted=true) - root cause funnet ved kildelesing (IKKE gjettet): §P
 * sin allerede-vellykkede `delete_permanent` av hovedtestfila etterlot den
 * FORTSATT i `sandbox.created`, så §5-oppryddingen forsøkte å slette den EN
 * GANG TIL - Drive sin 404 der traff klasse-D sin `preflight_action`
 * (`get_metadata`) FØR selve `deletePermanent()`-transportens egen
 * (allerede idempotente) 404-håndtering (`already_deleted: "true"`)
 * noensinne ble nådd (se live-transports.ts). Denne seksjonen beviser den
 * nye eksplisitte livssyklus-sporingen og den trygge, sandkasse-scopede
 * NOT_FOUND-klassifiseringen som fikser dette.
 */
describe("DriveAcceptanceSandbox - livssyklustilstand (HOST FIX #8 §A/§D/§E/§G/§H/§M)", () => {
  it("A: et artefakt merket PERMANENTLY_DELETED (§P-mønsteret) utelates HELT fra cleanupTargets() - INGEN redundant slettingsforsøk", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("subfolder-a");
    sandbox.trackCreated("hovedfil");
    sandbox.markPermanentlyDeleted("hovedfil");
    expect(sandbox.cleanupTargets()).toEqual(["subfolder-a", "root-1"]);
    expect(sandbox.stateOf("hovedfil")).toBe("PERMANENTLY_DELETED");
  });

  it("D: et TRASHET (men ikke permanent slettet) artefakt forblir et NORMALT cleanup-mål - trash alene ekskluderer ALDRI fra opprydding", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("hovedfil");
    sandbox.markTrashed("hovedfil");
    expect(sandbox.stateOf("hovedfil")).toBe("TRASHED");
    expect(sandbox.cleanupTargets()).toEqual(["hovedfil", "root-1"]);
  });

  it("E: barn ryddes FORTSATT før roten selv når noen barn er i en terminal tilstand og andre ikke er (blandet tilstand endrer aldri rekkefølgen)", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("child-a");
    sandbox.trackCreated("child-b");
    sandbox.trackCreated("child-c");
    sandbox.markPermanentlyDeleted("child-b");
    expect(sandbox.cleanupTargets()).toEqual(["child-c", "child-a", "root-1"]);
  });

  it("G: en auto-opprettet rot (autoCreated=true) forblir SISTE mål i cleanupTargets() - uendret fra tidligere", () => {
    const sandbox = new DriveAcceptanceSandbox("auto-rot", true);
    sandbox.trackCreated("barn-1");
    const targets = sandbox.cleanupTargets();
    expect(targets.at(-1)).toBe("auto-rot");
  });

  it("H: markTrashed()/markPermanentlyDeleted()/markCleaned() på en ALDRI sport ID er et rent no-op - kaster ALDRI, og sporer ALDRI en ny sandkasse-grense stille", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    expect(() => sandbox.markPermanentlyDeleted("aldri-sport-id")).not.toThrow();
    expect(() => sandbox.markTrashed("aldri-sport-id")).not.toThrow();
    expect(() => sandbox.markCleaned("aldri-sport-id")).not.toThrow();
    expect(sandbox.has("aldri-sport-id")).toBe(false);
    expect(sandbox.stateOf("aldri-sport-id")).toBeUndefined();
  });

  it("M: gjentatt opprydding er idempotent - etter markCleaned() forsvinner artefaktet FRA cleanupTargets() ved en ANDRE beregning (en ny cleanup-runde forsøker ALDRI det samme igjen)", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("barn-1");
    expect(sandbox.cleanupTargets()).toEqual(["barn-1", "root-1"]);
    sandbox.markCleaned("barn-1");
    sandbox.markCleaned("root-1"); // no-op for roten selv (aldri sport via trackCreated) - stateOf(root) er alltid undefined
    expect(sandbox.cleanupTargets()).toEqual(["root-1"]); // roten sin tilstand spores ikke, forblir derfor et mål - kun BARN kan markeres ferdig
  });

  it("nytt artefakt starter alltid i CREATED-tilstand ved trackCreated()", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("nytt-barn");
    expect(sandbox.stateOf("nytt-barn")).toBe("CREATED");
  });
});

describe("isNotFoundFailureReason (HOST FIX #8 §1)", () => {
  it("gjenkjenner BEGGE formene en Drive-404 kan komme tilbake som gjennom ToolGateway", () => {
    expect(isNotFoundFailureReason("tool_failed:drive_not_found_abc123")).toBe(true);
    expect(isNotFoundFailureReason("preflight_failed:drive_not_found_abc123")).toBe(true);
  });
  it("andre feilårsaker (rate-limit, auth, ukjent) gjenkjennes IKKE som NOT_FOUND", () => {
    expect(isNotFoundFailureReason("tool_failed:drive_rate_limited")).toBe(false);
    expect(isNotFoundFailureReason("tool_failed:drive_auth_error_403")).toBe(false);
    expect(isNotFoundFailureReason("preflight_failed:drive_error_500")).toBe(false);
  });
});

describe("classifyCleanupOutcome (HOST FIX #8 §2/§B/§C)", () => {
  it("et vellykket delete_permanent-svar klassifiseres 'cleaned', uansett årsaksfelt", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("barn-1");
    expect(classifyCleanupOutcome(sandbox, "barn-1", { ok: true })).toBe("cleaned");
  });

  it("B: en NOT_FOUND for et SPORT sandkasse-artefakt telles trygt som 'already_absent'", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("barn-1");
    expect(classifyCleanupOutcome(sandbox, "barn-1", { ok: false, reason: "tool_failed:drive_not_found_barn-1" })).toBe("already_absent");
  });

  it("C: en NOT_FOUND for en ID UTENFOR sandkassen (aldri sport) klassifiseres ALDRI som 'already_absent' - ALLTID 'failed', selv om feilteksten ser identisk ut", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("barn-1");
    expect(classifyCleanupOutcome(sandbox, "en-vilkårlig-fil-utenfor-sandkassen", { ok: false, reason: "tool_failed:drive_not_found_en-vilkårlig-fil-utenfor-sandkassen" })).toBe(
      "failed"
    );
  });

  it("en EKTE feilårsak (rate-limit/auth/ukjent) for et sport artefakt klassifiseres ALDRI som 'already_absent' - kun en faktisk 404 teller", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("barn-1");
    expect(classifyCleanupOutcome(sandbox, "barn-1", { ok: false, reason: "tool_failed:drive_rate_limited" })).toBe("failed");
    expect(classifyCleanupOutcome(sandbox, "barn-1", { ok: false, reason: "tool_failed:drive_auth_error_403" })).toBe("failed");
  });

  it("et deleteResult uten en reason-streng klassifiseres 'failed', aldri en krasj", () => {
    const sandbox = new DriveAcceptanceSandbox("root-1", true);
    sandbox.trackCreated("barn-1");
    expect(classifyCleanupOutcome(sandbox, "barn-1", { ok: false })).toBe("failed");
  });
});
