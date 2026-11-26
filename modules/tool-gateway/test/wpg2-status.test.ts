import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERSONAL_CAPABILITY_STATUS, PERSONAL_FLAG_NAMES } from "../src/personal/index.ts";

/**
 * WP-G2 (D-464): status i kode og runbook kan ikke drive fra hverandre. Et flagg uten en synlig status, en utsatt del som mangler `next_step`, eller en id som ikke står i runbooken feiler her (aldri en stille utelatelse).
 */
const RUNBOOK = readFileSync(join(fileURLToPath(new URL("../../..", import.meta.url)), "docs/runbooks/WPG2_PERSONAL.md"), "utf8");

describe("PERSONAL_CAPABILITY_STATUS", () => {
  it("hver id står i runbooken, og ingen id er duplisert", () => {
    const ids = PERSONAL_CAPABILITY_STATUS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(RUNBOOK, id).toContain(`\`${id}\``);
  });

  it("omvendt retning (fiks-runde 2, review A NY-2): runbookens status-tabell (§0) og koden har NØYAKTIG samme id-er - en id kan verken slettes fra koden eller legges til bare i runbooken", () => {
    const section = RUNBOOK.slice(RUNBOOK.indexOf("## 0. Status i ett blikk"), RUNBOOK.indexOf("## 1. Flagg"));
    const runbookIds = [...section.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1] as string);
    expect(runbookIds.length).toBeGreaterThan(5);
    expect([...runbookIds].sort()).toEqual(PERSONAL_CAPABILITY_STATUS.map((s) => s.id).sort());
  });

  it("`p1a_outcome_reconcile` er BYGGET (WP-G2c, D-483, Q-73 pkt 10): `DORMANT` + `PARTIAL` (ikke lenger `DEFERRED`), med et konkret neste steg som sier hva som gjenstår (bil kan ikke bli `failed`), og id-en står i runbook-tabellen - sletter noen posten, eller setter den tilbake til DEFERRED, feller denne testen", () => {
    const entry = PERSONAL_CAPABILITY_STATUS.find((s) => s.id === "p1a_outcome_reconcile");
    expect(entry).toBeDefined();
    expect(entry?.status).toEqual(["DORMANT", "PARTIAL"]);
    expect(entry?.status as readonly string[]).not.toContain("DEFERRED");
    expect(entry?.next_step ?? "").toMatch(/bil/);
    expect(entry?.next_step ?? "").toMatch(/failed/);
    expect(entry?.note ?? "").toMatch(/\/personal\/actions\/reconcile/);
    expect(entry?.note ?? "").toMatch(/aldri en automatisk retry/i);
    expect(RUNBOOK).toContain("`p1a_outcome_reconcile`");
    // runbook-raden sier det samme som koden: bygget (DORMANT/PARTIAL), ikke utsatt
    const row = RUNBOOK.split("\n").find((l) => l.startsWith("| `p1a_outcome_reconcile` |")) ?? "";
    expect(row).toMatch(/DORMANT/);
    expect(row).toMatch(/PARTIAL/);
    expect(row).not.toMatch(/\| `DEFERRED`/);
    // og ruten og migrasjonen finnes faktisk (ingen status uten kode)
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    expect(readFileSync(join(root, "apps/api/src/personal-routes.ts"), "utf8")).toContain('"/personal/actions/reconcile"');
    expect(readFileSync(join(root, "modules/core/src/db/migrations/144_personal_action_reconcile.sql"), "utf8")).toContain("reconcile_attempts");
  });

  it("hvert JARVIS_PERSONAL_*-flagg har en status (ingen flagg uten synlig status), og alle flaggene står i runbookens flaggtabell", () => {
    const flagged = new Set(PERSONAL_CAPABILITY_STATUS.flatMap((s) => (s.flag === undefined ? [] : [s.flag])));
    for (const name of Object.values(PERSONAL_FLAG_NAMES)) {
      expect(flagged.has(name), name).toBe(true);
      expect(RUNBOOK, name).toContain(name);
    }
  });

  it("utsatte, blokkerte og delvise deler sier nøyaktig hva som må til; ingenting er stilt «verifisert», og de reserverte flaggene (ingen effekt) er `DEFERRED`/`BUILT_UNWIRED`", () => {
    for (const s of PERSONAL_CAPABILITY_STATUS) {
      if (s.status.some((w) => w === "DEFERRED" || w === "BLOCKED_EXTERNAL" || w === "PARTIAL")) expect(s.next_step, s.id).toMatch(/.{15}/);
      expect(s.note.length, s.id).toBeGreaterThan(20);
      expect(s.status as readonly string[], s.id).not.toContain("VERIFIED");
    }
    const reserved = PERSONAL_CAPABILITY_STATUS.filter((s) => s.flag !== undefined && !(s.status as readonly string[]).includes("DORMANT"));
    expect(reserved.map((s) => s.flag).sort()).toEqual(["JARVIS_PERSONAL_CONTEXT"]);
    for (const s of reserved) expect(s.status.some((w) => w === "DEFERRED" || w === "BUILT_UNWIRED"), s.id).toBe(true);
  });
});
