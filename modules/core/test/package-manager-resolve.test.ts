import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findExecutableOnPath,
  readPinnedPackageManager,
  resolvePackageManager,
  type PathLookupEnv
} from "../scripts/lib/package-manager-resolve.ts";

/**
 * Q-20 HOST RECOVERY #2 (2026-08-16): `spawnSync("pnpm", ...)` UTEN
 * `shell: true` feiler med `ENOENT` på Windows sjøl om `pnpm` fungerer fint
 * fra Tobias sin egen PowerShell - Node gjør IKKE Windows sin PATHEXT-
 * baserte utvidelsesoppløsning (`.CMD`/`.EXE`/`.BAT`) uten en shell. Denne
 * suiten beviser §9.A-G i BO-en - rene funksjoner, ingen ekte Windows-vert
 * eller faktisk prosess-spawning nødvendig (alt av PATH/PATHEXT/filsystem
 * injiseres).
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

  it("resolvePackageManager velger pnpm.cmd direkte (driver=pnpm.cmd, useShell=true) når den finnes", () => {
    const env = fakeEnv({
      platform: "win32",
      pathEnv: "C:\\Users\\tobias\\AppData\\Roaming\\npm",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      existingPaths: ["C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.COM"] // .COM prøves FØR .CMD i standard-PATHEXT
    });
    const resolved = resolvePackageManager(env, pinned);
    expect(resolved.driver).toBe("pnpm.cmd");
    expect(resolved.command).toBe("C:\\Users\\tobias\\AppData\\Roaming\\npm\\pnpm.COM");
    expect(resolved.useShell).toBe(true);
    expect(resolved.argsPrefix).toEqual([]);
  });

  it("på ikke-Windows brukes bare navnet direkte (ingen utvidelse, useShell=false) - uendret unix-oppførsel", () => {
    const env = fakeEnv({ platform: "linux", pathEnv: "/usr/local/bin", existingPaths: ["/usr/local/bin/pnpm"] });
    const resolved = resolvePackageManager(env, pinned);
    expect(resolved.driver).toBe("pnpm");
    expect(resolved.command).toBe("/usr/local/bin/pnpm");
    expect(resolved.useShell).toBe(false);
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
    expect(resolved.useShell).toBe(true);
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
