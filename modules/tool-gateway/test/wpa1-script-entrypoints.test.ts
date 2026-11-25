import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * WP-A1 (reviewer A delta N2): live-scriptene kjører `main()` bare når de er inngangspunktet. `import.meta.url` er realpath, mens `process.argv[1]` er stien som ble skrevet; gikk den via en symlinket mappe ble
 * `main()` en STILLE no-op med exit 0 (ingen utskrift, ingen feil). Her kjøres begge scriptene for ekte via en symlinket mappe og via den direkte stien: utskriften og exit-koden skal være like.
 */
const SCRIPTS = resolve(fileURLToPath(new URL("../scripts", import.meta.url)));
const workdir = mkdtempSync(join(tmpdir(), "wpa1-entry-"));
const linked = join(workdir, "scripts-link");
symlinkSync(SCRIPTS, linked, "dir");
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const supported = process.allowedNodeEnvironmentFlags.has("--experimental-transform-types");
const runScript = (dir: string, file: string, args: string[]) =>
  spawnSync(process.execPath, ["--no-warnings", "--experimental-transform-types", join(dir, file), ...args], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env["PATH"], HOME: workdir } });

describe.skipIf(!supported)("live-scriptene kjører som inngangspunkt også via en symlinket mappe", () => {
  it("ua5-github-live: uten repo-argument gir både direkte sti og symlinket sti «repo mangler» og exit 2 (aldri en stille no-op)", () => {
    for (const dir of [SCRIPTS, linked]) {
      const r = runScript(dir, "ua5-github-live.ts", []);
      expect(r.stdout, dir).toContain("FEIL: repo mangler");
      expect(r.stdout, dir).toContain("LIVE_PROVIDER_VERIFIED=false");
      expect(r.status, `${dir}: ${r.stderr}`).toBe(2);
    }
  });

  it("ua5-github-live: et produksjonsrepo som argument nektes (exit 2, ingenting kjørt mot GitHub), også via symlinket sti", () => {
    for (const dir of [SCRIPTS, linked]) {
      const r = runScript(dir, "ua5-github-live.ts", ["FFrollerskis/jarvis-build.git"]);
      expect(r.stdout, dir).toContain("er et produksjonsrepo");
      expect(r.stdout, dir).toContain("Ingenting er kjørt mot GitHub");
      expect(r.status, `${dir}: ${r.stderr}`).toBe(2);
    }
  });

  it("github-app-live: --help skriver bruken og avslutter 0, både via direkte sti og via symlinket sti", () => {
    for (const dir of [SCRIPTS, linked]) {
      const r = runScript(dir, "github-app-live.ts", ["--help"]);
      expect(r.stdout, dir).toContain("Bruk: github-app-live.ts");
      expect(r.status, `${dir}: ${r.stderr}`).toBe(0);
    }
  });
});
