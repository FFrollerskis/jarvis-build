import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSpawnInvocation,
  findExecutableOnPath,
  readPinnedPackageManager,
  resolvePackageManager,
  type PathLookupEnv
} from "../scripts/lib/package-manager-resolve.ts";

/**
 * Q-20 HOST RECOVERY #2 (2026-08-16): `spawnSync("pnpm", ...)` UTEN
 * shell-involvering feiler med `ENOENT` på Windows sjøl om `pnpm` fungerer
 * fint fra Tobias sin egen PowerShell - Node gjør IKKE Windows sin PATHEXT-
 * baserte utvidelsesoppløsning (`.CMD`/`.EXE`/`.BAT`) uten en shell.
 *
 * HOST RECOVERY #3 (samme dag): runde #2 sin `shell: true`-fiks utløste
 * Node sin `DEP0190`-advarsel (`shell: true` + args-array er en kjent
 * injeksjonsrisiko). `buildSpawnInvocation()` erstatter det HELT - et
 * `.cmd`-shim kjøres nå via en eksplisitt cmd.exe-barneprosess med sitt eget
 * kontrollerte argv, ALDRI `shell: true`.
 *
 * Denne suiten beviser §9.A-G i BO-en (host-runde 2) + DEP0190-regresjonene
 * fra host-runde 3 - rene funksjoner, ingen ekte Windows-vert eller faktisk
 * prosess-spawning nødvendig (alt av PATH/PATHEXT/filsystem injiseres).
 */
function fakeEnv(overrides: Partial<PathLookupEnv> & { existingPaths: string[] }): PathLookupEnv {
  return {
    platform: overrides.platform ?? "win32",
    pathEnv: overrides.pathEnv ?? "",
    pathExt: overrides.pathExt ?? "",
    exists: (p: string) => overrides.existingPaths.includes(p)
  };
}

const pinned = { name: "pnpm", version: "9.15.9" };

describe("§9.A: Windows pnpm.cmd-oppløsning", () => {
  it("finner pnpm.cmd på PATH via PATHEXT-utvidelser, i rekkefølgen PATHEXT selv angir", () => {
    const env = fakeEnv({
      platform: "win32",
      pathEnv: "C:\\nope;C:\\Users\\tobias\\AppData\\Roaming\\npm",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      existingPaths: ["C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.CMD"]
    });
    const found = findExecutableOnPath("pnpm", env);
    expect(found).toBe("C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.CMD");
  });

  it("resolvePackageManager velger pnpm.cmd direkte (driver=pnpm.cmd, requiresCmdWrapper=true fordi .cmd ikke kan kjøres av CreateProcess direkte)", () => {
    const env = fakeEnv({
      platform: "win32",
      pathEnv: "C:\\Users\\tobias\\AppData\\Roaming\\npm",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      existingPaths: ["C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.CMD"]
    });
    const resolved = resolvePackageManager(env, pinned);
    expect(resolved.driver).toBe("pnpm.cmd");
    expect(resolved.command).toBe("C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.CMD");
    expect(resolved.requiresCmdWrapper).toBe(true);
    expect(resolved.argsPrefix).toEqual([]);
  });

  it("et NATIVT pnpm.exe på Windows trenger IKKE cmd.exe-wrapping (kun .cmd/.bat gjør)", () => {
    const env = fakeEnv({
      platform: "win32",
      pathEnv: "C:\\Users\\tobias\\AppData\\Roaming\\npm",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      existingPaths: ["C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.EXE"] // .COM prøves først, ikke funnet -> .EXE
    });
    const resolved = resolvePackageManager(env, pinned);
    expect(resolved.command).toBe("C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.EXE");
    expect(resolved.requiresCmdWrapper).toBe(false);
  });

  it("på ikke-Windows brukes bare navnet direkte (ingen utvidelse, requiresCmdWrapper=false) - uendret unix-oppførsel", () => {
    const env = fakeEnv({ platform: "linux", pathEnv: "/usr/local/bin", existingPaths: ["/usr/local/bin/pnpm"] });
    const resolved = resolvePackageManager(env, pinned);
    expect(resolved.driver).toBe("pnpm");
    expect(resolved.command).toBe("/usr/local/bin/pnpm");
    expect(resolved.requiresCmdWrapper).toBe(false);
  });
});

describe("§9.B: Corepack-fallback", () => {
  it("faller tilbake til corepack.cmd når pnpm ikke finnes noe sted på PATH", () => {
    const env = fakeEnv({
      platform: "win32",
      pathEnv: "C:\\Program Files\\nodejs",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      existingPaths: ["C:\\Program Files\\nodejs\\corepack.CMD"]
    });
    const resolved = resolvePackageManager(env, pinned);
    expect(resolved.driver).toBe("corepack");
    expect(resolved.command).toBe("C:\\Program Files\\nodejs\\corepack.CMD");
    expect(resolved.requiresCmdWrapper).toBe(true);
  });

  it("Corepack-fallback bruker EKSPLISITT den pinnede versjonen (pnpm@9.15.9), ikke en implisitt/nyere versjon", () => {
    const env = fakeEnv({
      platform: "win32",
      pathEnv: "C:\\Program Files\\nodejs",
      pathExt: ".CMD",
      existingPaths: ["C:\\Program Files\\nodejs\\corepack.CMD"]
    });
    const resolved = resolvePackageManager(env, pinned);
    expect(resolved.argsPrefix).toEqual(["pnpm@9.15.9"]);
  });
});

describe("§9.C: ingen kjørbar fil -> tydelig fail-closed diagnostikk", () => {
  it("kaster en beskrivende feil (ikke en kryptisk ENOENT) når verken pnpm eller corepack finnes", () => {
    const env = fakeEnv({ platform: "win32", pathEnv: "C:\\empty", pathExt: ".CMD", existingPaths: [] });
    expect(() => resolvePackageManager(env, pinned)).toThrowError(/package_manager_resolution=FAIL/);
  });

  it("feilmeldingen ber ALDRI om å KJØRE 'corepack enable' eller å endre PATH manuelt (kun eksplisitt IKKE-krav)", () => {
    const env = fakeEnv({ platform: "win32", pathEnv: "", pathExt: "", existingPaths: [] });
    try {
      resolvePackageManager(env, pinned);
      throw new Error("skulle ha kastet");
    } catch (err) {
      const message = (err as Error).message;
      // "corepack enable"/PATH nevnes bevisst - men KUN som "IKKE nødvendig", aldri som en instruksjon.
      expect(message).toMatch(/IKKE nødvendig.*corepack enable/);
      expect(message).not.toMatch(/^(?!.*IKKE).*kjør\s+['"]?corepack enable/i);
    }
  });
});

describe("§9.D: pinnet packageManager-versjon respekteres", () => {
  it("leser 'pnpm@9.15.9' korrekt fra package.json sitt packageManager-felt", () => {
    const rootPackageJson = readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8");
    const result = readPinnedPackageManager(rootPackageJson);
    expect(result).toEqual({ name: "pnpm", version: "9.15.9" });
  });

  it("returnerer undefined for en package.json uten packageManager-felt (ingen krasj)", () => {
    expect(readPinnedPackageManager("{}")).toBeUndefined();
  });
});

describe("Q-20 HOST RECOVERY #3: buildSpawnInvocation er DEP0190-trygg (ALDRI shell: true)", () => {
  it("wrapper et .cmd-shim via en eksplisitt cmd.exe-barneprosess (/d /s /c <sti> <args>), ikke via shell:true", () => {
    const resolved = resolvePackageManager(
      fakeEnv({
        platform: "win32",
        pathEnv: "C:\\Users\\tobias\\AppData\\Roaming\\npm",
        pathExt: ".CMD",
        existingPaths: ["C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.CMD"]
      }),
      pinned
    );
    const invocation = buildSpawnInvocation(resolved, ["install", "--frozen-lockfile"], "C:\\Windows\\System32\\cmd.exe");
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args).toEqual(["/d", "/s", "/c", "C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.CMD", "install", "--frozen-lockfile"]);
  });

  it("Corepack-fallback via cmd.exe setter argsPrefix (pnpm@<versjon>) FØR de faktiske kommandoargumentene", () => {
    const resolved = resolvePackageManager(
      fakeEnv({ platform: "win32", pathEnv: "C:\\nodejs", pathExt: ".CMD", existingPaths: ["C:\\nodejs\\corepack.CMD"] }),
      pinned
    );
    const invocation = buildSpawnInvocation(resolved, ["install", "--frozen-lockfile"], "C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args).toEqual(["/d", "/s", "/c", "C:\\nodejs\\corepack.CMD", "pnpm@9.15.9", "install", "--frozen-lockfile"]);
  });

  it("et NATIVT .exe (eller unix-binær) kjøres DIREKTE - ingen cmd.exe-wrapper, ingen unødvendig indirection", () => {
    const resolvedExe = resolvePackageManager(
      fakeEnv({
        platform: "win32",
        pathEnv: "C:\\nodejs",
        pathExt: ".COM;.EXE;.BAT;.CMD",
        existingPaths: ["C:\\nodejs\\pnpm.EXE"]
      }),
      pinned
    );
    const invocation = buildSpawnInvocation(resolvedExe, ["install", "--frozen-lockfile"]);
    expect(invocation.command).toBe("C:\\nodejs\\pnpm.EXE");
    expect(invocation.args).toEqual(["install", "--frozen-lockfile"]);

    const resolvedUnix = resolvePackageManager(fakeEnv({ platform: "linux", pathEnv: "/usr/bin", existingPaths: ["/usr/bin/pnpm"] }), pinned);
    const unixInvocation = buildSpawnInvocation(resolvedUnix, ["install", "--frozen-lockfile"]);
    expect(unixInvocation.command).toBe("/usr/bin/pnpm");
    expect(unixInvocation.args).toEqual(["install", "--frozen-lockfile"]);
  });

  it("package-manager-resolve.ts og q20-host-run.ts inneholder ALDRI faktisk KODE med 'shell: true' (kommentarer kan advare mot det - DEP0190-vakt)", () => {
    const libSource = readFileSync(fileURLToPath(new URL("../scripts/lib/package-manager-resolve.ts", import.meta.url)), "utf8");
    const hostRunSource = readFileSync(fileURLToPath(new URL("../scripts/q20-host-run.ts", import.meta.url)), "utf8");
    for (const source of [libSource, hostRunSource]) {
      const codeOnly = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/**"))
        .join("\n");
      expect(codeOnly).not.toMatch(/shell\s*:\s*true/);
    }
  });
});

describe("§9.G: aldri en instruksjon om å KJØRE 'corepack enable' noe sted i biblioteket", () => {
  it("package-manager-resolve.ts ber ALDRI om å kjøre 'corepack enable' (kan nevne det, kun som eksplisitt IKKE-krav)", () => {
    const source = readFileSync(fileURLToPath(new URL("../scripts/lib/package-manager-resolve.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/kjør\s+['"]?corepack enable/i);
    if (source.includes("corepack enable")) {
      expect(source).toMatch(/ALDRI.*corepack enable|IKKE.*corepack enable/);
    }
  });

  it("biblioteket importerer INGEN npm-pakker eller @jarvis/*-workspace-pakker (må virke FØR pnpm install)", () => {
    const source = readFileSync(fileURLToPath(new URL("../scripts/lib/package-manager-resolve.ts", import.meta.url)), "utf8");
    const importLines = source.split("\n").filter((l) => l.trim().startsWith("import "));
    expect(importLines).toEqual([]);
  });
});
