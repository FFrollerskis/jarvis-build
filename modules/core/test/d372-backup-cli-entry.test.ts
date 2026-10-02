import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** D-372: CLI-en må faktisk kjøre main() når den startes som skript (Windows ga stille exit 0). */
const CLI = resolve(__dirname, "../../../ops/backup/jarvis-backup.mjs");

describe("D-372 jarvis-backup.mjs entry", () => {
  it("kjører main(): ukjent kommando gir usage og exit 1, ikke stille exit 0", () => {
    const r = spawnSync(process.execPath, [CLI, "bogus"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usage: jarvis-backup.mjs");
  });

  it("status uten backup-sett gir ok:false og exit 3", () => {
    const r = spawnSync(process.execPath, [CLI, "status", "--out", resolve(__dirname, "ikke-eksisterende-mappe")], { encoding: "utf8" });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('"ok":false');
  });
});
