import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { BUDGET_HARD_CEILINGS, BudgetLock, ChangeLedger, ConstitutionError, buildConstitution, startOfUtcDay, type BudgetCaps, type LedgerCounter } from "../src/index.ts";

/** EV-0 (D-409): budsjettlåser - ren logikk + ekte Postgres (telling fra endringsregisteret). */
const repoManifest = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("../../../config/evolution/constitution.v1.json", import.meta.url), "utf8"));
const code = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return (err as ConstitutionError).code ?? `other:${(err as Error).message}`; }
  return "no_error";
};
const CAPS: BudgetCaps = {
  max_auto_merges_per_day: 2, max_deploys_per_day: 1, max_deploys_per_hour: 1, max_owner_proposals_per_day: 3, max_evolution_cost_ore_per_month: 1000,
  max_radar_cost_ore_per_month: 200, max_eval_cost_ore_per_month: 300, max_redteam_cost_ore_per_month: 100, max_shadow_cost_ore_per_month: 100, max_review_cost_ore_per_month: 300,
  owner_time_budget_minutes_per_week: 120, max_owner_minutes_per_autonomous_change: 10
};
const fixed = (iso: string) => () => new Date(iso);
const counter = (n: number): LedgerCounter => ({ countSince: async () => n });

describe("A: grensene i det signerte manifestet", () => {
  it("A1: repoets manifest har gyldige grenser innenfor de harde takene", () => {
    const c = buildConstitution(repoManifest());
    for (const key of Object.keys(BUDGET_HARD_CEILINGS) as Array<keyof typeof BUDGET_HARD_CEILINGS>) {
      expect(c.budget[key], key).toBeLessThanOrEqual(BUDGET_HARD_CEILINGS[key]);
    }
  });

  it("A2: manifest uten budget_caps, med ukjent felt eller negativ verdi avvises", () => {
    const m = repoManifest();
    delete m["budget_caps"];
    expect(code(() => buildConstitution(m))).toBe("constitution_invalid");
    expect(code(() => buildConstitution({ ...repoManifest(), budget_caps: { ...CAPS, extra: 1 } }))).toBe("constitution_invalid");
    expect(code(() => buildConstitution({ ...repoManifest(), budget_caps: { ...CAPS, max_deploys_per_day: -1 } }))).toBe("constitution_invalid");
  });

  it("A3: selv et signert manifest kan ikke sette en grense over det harde taket (constitution_weakened)", () => {
    for (const key of Object.keys(BUDGET_HARD_CEILINGS) as Array<keyof typeof BUDGET_HARD_CEILINGS>) {
      const caps = { ...CAPS, [key]: BUDGET_HARD_CEILINGS[key] + 1 };
      expect(code(() => buildConstitution({ ...repoManifest(), budget_caps: caps })), key).toBe("constitution_weakened");
    }
  });

  it("A4: grensene er frosset på Constitution-objektet (kan ikke heves i kjøretid)", () => {
    const c = buildConstitution(repoManifest());
    expect(Object.isFrozen(c.budget)).toBe(true);
    expect(() => { (c.budget as { max_deploys_per_day: number }).max_deploys_per_day = 999; }).toThrow();
  });
});

describe("B: BudgetLock (ren logikk, fiktivt register)", () => {
  it("B1: under grensen tillatt, ved grensen stoppet", async () => {
    expect(await new BudgetLock(CAPS, counter(1)).checkAutoMerge()).toMatchObject({ allowed: true, used: 1, limit: 2, remaining: 1 });
    expect(await new BudgetLock(CAPS, counter(2)).checkAutoMerge()).toMatchObject({ allowed: false, reason: "budget_exhausted", used: 2, limit: 2 });
    expect(await new BudgetLock(CAPS, counter(1)).checkDeploy()).toMatchObject({ allowed: false, reason: "budget_exhausted" });
    expect(await new BudgetLock(CAPS, counter(3)).checkOwnerProposal()).toMatchObject({ allowed: false });
  });

  it("B2: grense 0 stenger alltid", async () => {
    expect((await new BudgetLock({ ...CAPS, max_auto_merges_per_day: 0 }, counter(0)).checkAutoMerge()).allowed).toBe(false);
  });

  it("B3: feil ved lesing av forbruket gir «ikke tillatt» (fail-closed)", async () => {
    const broken: LedgerCounter = { countSince: async () => { throw new Error("db nede"); } };
    expect(await new BudgetLock(CAPS, broken).checkAutoMerge()).toMatchObject({ allowed: false, reason: "budget_check_failed" });
  });

  it("B4: tellingen starter ved UTC-midnatt", async () => {
    let since = "";
    const spy: LedgerCounter = { countSince: async (s) => { since = s; return 0; } };
    await new BudgetLock(CAPS, spy, fixed("2026-10-06T23:59:59Z")).checkAutoMerge();
    expect(since).toBe("2026-10-06T00:00:00.000Z");
    expect(startOfUtcDay(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
  });

  it("B5: kostgrense - innenfor, over, og ugyldige tall avvises", () => {
    const lock = new BudgetLock(CAPS, counter(0));
    expect(lock.checkSpend(900, 100)).toMatchObject({ allowed: true, remaining: 0 });
    expect(lock.checkSpend(900, 101)).toMatchObject({ allowed: false, reason: "budget_exhausted" });
    for (const [a, b] of [[-1, 1], [1, -1], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY]] as const) {
      expect(lock.checkSpend(a, b), `${a},${b}`).toMatchObject({ allowed: false, reason: "budget_check_failed" });
    }
  });
});

let adminPool: pg.Pool;
let appPool: pg.Pool;
let stop: (() => Promise<void>) | undefined;
const DIGEST = "d".repeat(64);
const SHA = "e".repeat(40);

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-budget-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_budget_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_budget_test");
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_budget_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
});

const entry = (change_id: string, change_class: "E1" | "E2", decision: "merged" | "deployed" | "proposed") => ({
  change_id, change_class, decision, constitution_digest: DIGEST, subject: "s", paths: ["x"], branch: "b", head_sha: SHA,
  evidence: change_class === "E1" ? { ci_green: true } : { approved_by: "o", approved_head_sha: SHA }, recorded_by: "jarvis-core"
});

describe("C: telling fra ekte endringsregister", () => {
  it("C1: auto-merger telles (kun E0/E1 merged), E2-merger og forslag teller ikke mot auto-grensen, og låsen stopper ved grensen", async () => {
    const ledger = new ChangeLedger(appPool);
    const lock = new BudgetLock(CAPS, ledger);
    expect((await lock.checkAutoMerge()).allowed).toBe(true);
    await ledger.append(entry("a1", "E1", "merged"));
    await ledger.append(entry("e2-merge", "E2", "merged")); // eier-godkjent: teller ikke
    await ledger.append(entry("p1", "E2", "proposed"));
    expect(await lock.checkAutoMerge()).toMatchObject({ allowed: true, used: 1, remaining: 1 });
    await ledger.append(entry("a2", "E1", "merged"));
    expect(await lock.checkAutoMerge()).toMatchObject({ allowed: false, reason: "budget_exhausted", used: 2 });
  });

  it("C2: deploys og eier-forslag telles hver for seg", async () => {
    const ledger = new ChangeLedger(appPool);
    const lock = new BudgetLock(CAPS, ledger);
    expect((await lock.checkDeploy()).allowed).toBe(true);
    await ledger.append(entry("d1", "E2", "deployed"));
    expect(await lock.checkDeploy()).toMatchObject({ allowed: false, used: 1 });
    expect(await lock.checkOwnerProposal()).toMatchObject({ allowed: true, used: 1, remaining: 2 });
  });

  it("C3: rader fra i går telles ikke (døgnvindu)", async () => {
    const ledger = new ChangeLedger(appPool);
    const tomorrow = new BudgetLock(CAPS, ledger, fixed(new Date(Date.now() + 36 * 3600_000).toISOString()));
    expect(await tomorrow.checkAutoMerge()).toMatchObject({ allowed: true, used: 0 });
  });
});
