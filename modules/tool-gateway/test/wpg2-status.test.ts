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

  it("`outcome_unknown` avstemmes ikke og er IKKE stille utelatt (CLAUDE.md regel 11): `p1a_outcome_reconcile` står som DEFERRED med et konkret neste steg - sletter noen posten, feller denne testen", () => {
    const entry = PERSONAL_CAPABILITY_STATUS.find((s) => s.id === "p1a_outcome_reconcile");
    expect(entry).toBeDefined();
    expect(entry?.status).toEqual(["DEFERRED"]);
    expect(entry?.next_step ?? "").toMatch(/reconcile/);
    expect(RUNBOOK).toContain("`p1a_outcome_reconcile`");
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
