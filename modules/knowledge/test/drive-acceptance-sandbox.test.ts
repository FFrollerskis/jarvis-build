import { describe, expect, it } from "vitest";
import {
  DriveAcceptanceSandbox,
  DriveBoundaryViolationError,
  determineTestRootSource,
  driveAcceptanceFolderName,
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
