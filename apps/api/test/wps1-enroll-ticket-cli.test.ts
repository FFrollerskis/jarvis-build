import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENROLLABLE_DEVICE_KINDS } from "@jarvis/contracts";

/**
 * WP-S1 K3: eierens billett-CLI (`apps/api/src/enroll-ticket-main.ts`, den ENESTE veien en eier utsteder en billett fra en terminal) krever `--kind` og har INGEN standard. Typen avgjør hvilke kanaler enheten kan få
 * en økt for; en stille standard (f.eks. `web_browser`) ville gitt hver billett step-up-evne uten at eieren valgte det. Testen kjører CLI-en som en egen prosess (samme som eieren): ugyldig/manglende `--kind`
 * stopper (kode 2) FØR noe kobles til databasen; en gyldig type passerer valideringen (og feiler først på databasen: porten under er bevisst lukket, så ingenting kan bli skrevet noe sted).
 */
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "src", "enroll-ticket-main.ts");

function runCli(args: readonly string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--experimental-transform-types", script, ...args], {
    cwd: join(here, ".."),
    // Minimalt, kontrollert miljø: gyldig eier-konfig, og en LUKKET databaseport så ingen billett kan opprettes selv om validering skulle passere.
    env: {
      PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", JARVIS_TENANT_ID: "tenant-s1c", JARVIS_OWNER_PERSON_ID: "person-s1c", JARVIS_OWNER_NAME: "Test Owner",
      JARVIS_DB_HOST: "127.0.0.1", JARVIS_DB_PORT: "1"
    },
    encoding: "utf8",
    timeout: 60_000
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

const KIND_ERROR = "mangler eller ugyldig --kind";

describe("WP-S1 K3: enroll-ticket-CLI krever --kind uten standard", () => {
  it("uten --kind: avslutter med kode 2 og forklarer, FØR databasen røres; ingen billett skrives ut", () => {
    const r = runCli([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(KIND_ERROR);
    expect(r.stderr).toContain("har ingen standard");
    expect(r.stdout).not.toContain("enr_");
  }, 90_000);

  for (const bad of ["legacy_unknown", "Iphone", "web", "", "phone", "iphone ", "watch,service"]) {
    it(`ugyldig --kind ${JSON.stringify(bad)}: kode 2 (legacy_unknown og skrivefeil er aldri en billettype)`, () => {
      const r = runCli(["--kind", bad]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(KIND_ERROR);
      expect(r.stdout).not.toContain("enr_");
    }, 90_000);
  }

  it("--kind som siste argument uten verdi: kode 2", () => {
    const r = runCli(["--device", "dev-x", "--kind"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(KIND_ERROR);
  }, 90_000);

  it("--kind=iphone (annen syntaks enn CLI-en støtter) regnes som manglende: ingen stille gjetning", () => {
    const r = runCli(["--kind=iphone"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(KIND_ERROR);
  }, 90_000);

  it("feilmeldingen lister NØYAKTIG de lukkede billettypene (aldri legacy_unknown)", () => {
    const r = runCli([]);
    expect(r.stderr).toContain(`(${ENROLLABLE_DEVICE_KINDS.join(" | ")})`);
    expect(r.stderr).not.toContain("legacy_unknown");
  }, 90_000);

  for (const good of ENROLLABLE_DEVICE_KINDS) {
    it(`--kind ${good}: passerer typevalideringen (feiler først mot den lukkede databaseporten, aldri med typefeilen)`, () => {
      const r = runCli(["--kind", good]);
      expect(r.stderr).not.toContain(KIND_ERROR);
      expect(r.status).not.toBe(2);
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("enr_");
    }, 90_000);
  }
});
