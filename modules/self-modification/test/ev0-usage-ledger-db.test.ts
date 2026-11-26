import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  BudgetLock, ChangeLedger, GENESIS_HASH, UsageLedger, UsageLedgerError, assertUsageRules, usageChainHash, verifyUsageChain, type BudgetCaps, type UsageEntryInput, type UsageLedgerRow
} from "../src/index.ts";

/** WP-EV0 (K5): forbruks-/eier-tid-registeret mot ekte Postgres (migrasjon 280) og BudgetLock mot de ekte registrene. */
const DIGEST = "c".repeat(64);
const CAPS: BudgetCaps = {
  max_auto_merges_per_day: 5, max_deploys_per_day: 3, max_deploys_per_hour: 2, max_owner_proposals_per_day: 6, max_evolution_cost_ore_per_month: 1000,
  max_radar_cost_ore_per_month: 100, max_eval_cost_ore_per_month: 200, max_redteam_cost_ore_per_month: 150, max_shadow_cost_ore_per_month: 250, max_review_cost_ore_per_month: 300,
  owner_time_budget_minutes_per_week: 120, max_owner_minutes_per_autonomous_change: 20
};
const code = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return (err as UsageLedgerError).code ?? `other:${(err as Error).message}`; }
  return "no_error";
};
const spend = (over: Partial<Extract<UsageEntryInput, { kind: "spend" }>> = {}): UsageEntryInput => ({
  kind: "spend", category: "radar", amount: 10, change_id: null, source_ref: "cost_events:1", constitution_digest: DIGEST, recorded_by: "metering:model-gateway", ...over
});
const owner = (over: Partial<Extract<UsageEntryInput, { kind: "owner_time" }>> = {}): UsageEntryInput => ({
  kind: "owner_time", category: "approval", amount: 5, change_id: "chg-1", source_ref: "audit_events:7", constitution_digest: DIGEST, recorded_by: "owner-console", ...over
});

describe("A: regler og hash (ren logikk)", () => {
  it("A1: eier-godkjenning og -review MÅ knyttes til en endring; merking og styring trenger ikke", () => {
    expect(code(() => assertUsageRules(owner({ category: "approval", change_id: null })))).toBe("usage_rule_violation");
    expect(code(() => assertUsageRules(owner({ category: "review", change_id: null })))).toBe("usage_rule_violation");
    expect(code(() => assertUsageRules(owner({ category: "label", change_id: null })))).toBe("no_error");
    expect(code(() => assertUsageRules(owner({ category: "governance", change_id: null })))).toBe("no_error");
    expect(code(() => assertUsageRules(spend({ change_id: null })))).toBe("no_error");
  });

  it("A2: kjeden verifiseres uavhengig; endret felt, fjernet rad, omkastet rekkefølge og hull avsløres på riktig seq", () => {
    const mk = (n: number): UsageLedgerRow[] => {
      const rows: UsageLedgerRow[] = [];
      let prev = GENESIS_HASH;
      for (let i = 1; i <= n; i++) {
        const partial = {
          seq: String(i), kind: "spend", category: "radar", amount: String(i * 10), change_id: i % 2 === 0 ? `c-${i}` : null, source_ref: `cost_events:${i}`,
          constitution_digest: DIGEST, recorded_by: "m", at_text: "2026-12-09T10:00:00.000000Z", prev_hash: prev
        };
        const row = { ...partial, entry_hash: usageChainHash(partial) };
        rows.push(row);
        prev = row.entry_hash;
      }
      return rows;
    };
    expect(verifyUsageChain(mk(5))).toMatchObject({ ok: true, count: 5, broken_seq: null });
    expect(verifyUsageChain([])).toMatchObject({ ok: true, count: 0, head_hash: GENESIS_HASH });
    const edited = mk(4); edited[1] = { ...edited[1]!, amount: "999" };
    expect(verifyUsageChain(edited)).toMatchObject({ ok: false, broken_seq: "2" });
    expect(verifyUsageChain(mk(4).filter((r) => r.seq !== "2"))).toMatchObject({ ok: false, broken_seq: "3" });
    const swapped = mk(3); [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(verifyUsageChain(swapped).ok).toBe(false);
    expect(verifyUsageChain(mk(3).slice(1))).toMatchObject({ ok: false, broken_seq: "2" });
    // hvert felt er med i hashen (en endring i NOEN av dem må avsløres)
    for (const key of ["kind", "category", "amount", "change_id", "source_ref", "constitution_digest", "recorded_by", "at_text", "prev_hash"] as const) {
      const rows = mk(2);
      rows[0] = { ...rows[0]!, [key]: key === "change_id" ? "annen" : key === "prev_hash" ? "1".repeat(64) : `${String(rows[0]![key])}x` };
      expect(verifyUsageChain(rows).ok, key).toBe(false);
    }
  });
});

let adminPool: pg.Pool;
let appPool: pg.Pool;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-usage-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_usage_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_usage_test");
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_usage_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
});

/** Rå INSERT som superbruker med eksplisitt tidspunkt (triggeren beholder `at` og beregner seq/hash selv). */
async function rawInsert(kind: string, category: string, amount: number, at: string, changeId: string | null = null, sourceRef = "test:1"): Promise<void> {
  await adminPool.query(
    `INSERT INTO evolution_usage_ledger (kind, category, amount, change_id, source_ref, constitution_digest, recorded_by, at, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6, 'test', $7::timestamptz, '', '')`, [kind, category, amount, changeId, sourceRef, DIGEST, at]);
}

describe("B: ekte Postgres (migrasjon 280) - integritet", () => {
  it("B1: tabellen er global (ingen tenant_id), uten RLS (dokumentert unntak), og jarvis_app har KUN SELECT + INSERT", async () => {
    const cols = (await adminPool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'evolution_usage_ledger'")).rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).not.toContain("tenant_id");
    expect(cols.sort()).toEqual(["amount", "at", "category", "change_id", "constitution_digest", "entry_hash", "kind", "prev_hash", "recorded_by", "seq", "source_ref"]);
    const rls = await adminPool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'evolution_usage_ledger'");
    expect(rls.rows[0].relrowsecurity).toBe(false);
    const privs = await adminPool.query(
      `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS p FROM information_schema.table_privileges WHERE grantee = 'jarvis_app' AND table_name = 'evolution_usage_ledger'`);
    expect(privs.rows[0].p).toEqual(["INSERT", "SELECT"]);
  });

  it("B2: append som jarvis_app gir seq 1.., prev_hash-kjede, og TypeScript-hash = databasens hash", async () => {
    const ledger = new UsageLedger(appPool);
    const a = await ledger.append(spend({ amount: 7 }));
    const b = await ledger.append(owner({ amount: 3 }));
    expect(a.seq).toBe("1");
    expect(a.prev_hash).toBe(GENESIS_HASH);
    expect(a.amount).toBe("7");
    expect(b.seq).toBe("2");
    expect(b.prev_hash).toBe(a.entry_hash);
    const { entry_hash, ...rest } = a;
    expect(usageChainHash(rest)).toBe(entry_hash);
    const { entry_hash: eh2, ...rest2 } = b;
    expect(usageChainHash(rest2)).toBe(eh2);
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("B3: appen kan ikke velge seq/hash/prev (trigger overstyrer) - rå INSERT med falske verdier gir likevel gyldig kjede", async () => {
    const r = await appPool.query(
      `INSERT INTO evolution_usage_ledger (seq, kind, category, amount, source_ref, constitution_digest, recorded_by, prev_hash, entry_hash)
       VALUES (999, 'spend', 'eval', 4, 'forged:1', $1, 'p', 'fake', 'fake') RETURNING seq::text AS seq, entry_hash`, [DIGEST]);
    expect(r.rows[0].seq).not.toBe("999");
    expect(r.rows[0].entry_hash).not.toBe("fake");
    expect((await new UsageLedger(appPool).verify()).ok).toBe(true);
  });

  it("B4: UPDATE, DELETE og TRUNCATE nektes - også for superbruker (trigger) og for jarvis_app (grants)", async () => {
    for (const sql of ["UPDATE evolution_usage_ledger SET amount = 1 WHERE seq = 1", "DELETE FROM evolution_usage_ledger WHERE seq = 1", "TRUNCATE evolution_usage_ledger"]) {
      await expect(adminPool.query(sql), `admin ${sql}`).rejects.toThrow(/append_only_table/);
      await expect(appPool.query(sql), `app ${sql}`).rejects.toThrow();
    }
  });

  it("B5: CHECK-reglene gjelder selv ved rå INSERT (kategori må høre til typen, beløp > 0, godkjenning/review trenger endring, trygt tegnsett)", async () => {
    const bad: Array<[string, () => Promise<void>]> = [
      ["spend med eier-kategori", () => rawInsert("spend", "approval", 1, "2026-12-09T10:00:00Z")],
      ["owner_time med kostnadskategori", () => rawInsert("owner_time", "radar", 1, "2026-12-09T10:00:00Z", "c")],
      ["ukjent kategori", () => rawInsert("spend", "marketing", 1, "2026-12-09T10:00:00Z")],
      ["ukjent type", () => rawInsert("credit", "radar", 1, "2026-12-09T10:00:00Z")],
      ["beløp 0", () => rawInsert("spend", "radar", 0, "2026-12-09T10:00:00Z")],
      ["negativt beløp", () => rawInsert("spend", "radar", -5, "2026-12-09T10:00:00Z")],
      ["beløp over overløpsvernet", () => rawInsert("spend", "radar", 1_000_000_001, "2026-12-09T10:00:00Z")],
      ["godkjenning uten endring", () => rawInsert("owner_time", "approval", 5, "2026-12-09T10:00:00Z", null)],
      ["review uten endring", () => rawInsert("owner_time", "review", 5, "2026-12-09T10:00:00Z", null)],
      ["source_ref med mellomrom", () => rawInsert("spend", "radar", 1, "2026-12-09T10:00:00Z", null, "cost events 1")],
      ["source_ref med = og ;", () => rawInsert("spend", "radar", 1, "2026-12-09T10:00:00Z", null, "key=abc;x")],
      ["source_ref tom", () => rawInsert("spend", "radar", 1, "2026-12-09T10:00:00Z", null, "")],
      ["source_ref for lang", () => rawInsert("spend", "radar", 1, "2026-12-09T10:00:00Z", null, "x".repeat(301))],
      ["tom change_id", () => rawInsert("spend", "radar", 1, "2026-12-09T10:00:00Z", "")]
    ];
    for (const [label, fn] of bad) await expect(fn(), label).rejects.toThrow(/violates check constraint|evolution_usage/);
    await expect(adminPool.query(`INSERT INTO evolution_usage_ledger (kind, category, amount, source_ref, constitution_digest, recorded_by, prev_hash, entry_hash) VALUES ('spend','radar',1,'ok:1','xyz','p','','')`)).rejects.toThrow(/check constraint/);
    await expect(adminPool.query(`INSERT INTO evolution_usage_ledger (kind, category, amount, source_ref, constitution_digest, recorded_by, prev_hash, entry_hash) VALUES ('spend','radar',1,'ok:1',$1,'har mellomrom','','')`, [DIGEST])).rejects.toThrow(/check constraint/);
  });

  it("B6: TypeScript avviser det samme FØR databasen (ukjent kategori, brøk, usikker referanse, ekstra felt) med usage_invalid_entry", async () => {
    const ledger = new UsageLedger(appPool);
    for (const bad of [
      spend({ category: "marketing" as never }), spend({ amount: 1.5 }), spend({ amount: 0 }), spend({ amount: -1 }), spend({ source_ref: "a b" }), spend({ source_ref: "k=v" }),
      spend({ recorded_by: "name with spaces" }), spend({ constitution_digest: "xyz" }), { ...spend(), extra: 1 } as never, { ...spend(), kind: "credit" } as never
    ]) {
      await expect(ledger.append(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: "usage_invalid_entry" });
    }
    await expect(ledger.append(owner({ category: "approval", change_id: null }))).rejects.toMatchObject({ code: "usage_rule_violation" });
  });

  it("B7: 12 samtidige innsettinger gir unike, sammenhengende seq og en gyldig kjede", async () => {
    const ledger = new UsageLedger(appPool);
    const before = (await ledger.all()).length;
    await Promise.all(Array.from({ length: 12 }, (_, i) => ledger.append(spend({ source_ref: `par:${i}`, amount: i + 1 }))));
    const rows = await ledger.all();
    expect(rows.length).toBe(before + 12);
    expect(rows.map((r) => Number(r.seq))).toEqual(rows.map((_, i) => i + 1));
    expect(verifyUsageChain(rows).ok).toBe(true);
  });

  it("B8: manipulasjon utenom triggerne (admin deaktiverer trigger og endrer en rad) avsløres av BÅDE databasen og TypeScript", async () => {
    const ledger = new UsageLedger(appPool);
    const target = (await ledger.all())[1]!;
    const c = await adminPool.connect();
    try {
      await c.query("ALTER TABLE evolution_usage_ledger DISABLE TRIGGER evolution_usage_no_update_delete");
      await c.query("UPDATE evolution_usage_ledger SET amount = 999999 WHERE seq = $1", [target.seq]);
      await c.query("ALTER TABLE evolution_usage_ledger ENABLE TRIGGER evolution_usage_no_update_delete");
    } finally {
      c.release();
    }
    const result = await ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.broken_seq).toBe(target.seq);
    expect((await adminPool.query("SELECT evolution_usage_ledger_verify()::text AS b")).rows[0].b).toBe(target.seq);
  });
});

/** NB: B8 ødela kjeden bevisst; resten av testene bruker nye rader med eksplisitt tid og sjekker kun summer/lås (ikke kjeden). */
describe("C: summer og BudgetLock mot de ekte registrene (deterministisk tid i desember 2099)", () => {
  const NOW = "2099-12-09T12:30:00.000Z"; // onsdag
  const clock = () => new Date(NOW);

  it("C1: sumSince respekterer vindu, type og kategorifilter; sumForChange summerer kun den endringen", async () => {
    await rawInsert("spend", "radar", 30, "2099-12-02T10:00:00Z", null, "c1:a");
    await rawInsert("spend", "radar", 20, "2099-11-29T10:00:00Z", null, "c1:b"); // forrige måned
    await rawInsert("spend", "eval", 40, "2099-12-03T10:00:00Z", null, "c1:c");
    await rawInsert("owner_time", "approval", 10, "2099-12-08T09:00:00Z", "chg-w", "c1:d"); // denne uken (mandag 7.)
    await rawInsert("owner_time", "label", 4, "2099-12-06T09:00:00Z", null, "c1:e"); // forrige uke (søndag 6.)
    await rawInsert("owner_time", "review", 8, "2099-12-09T09:00:00Z", "chg-w", "c1:f");
    const u = new UsageLedger(appPool);
    expect(await u.sumSince("spend", ["radar"], "2099-12-01T00:00:00.000Z")).toBe(30);
    expect(await u.sumSince("spend", ["radar"], "2099-11-01T00:00:00.000Z")).toBe(50);
    expect(await u.sumSince("spend", ["radar", "eval"], "2099-12-01T00:00:00.000Z")).toBe(70);
    expect(await u.sumSince("spend", null, "2099-12-01T00:00:00.000Z")).toBe(70);
    expect(await u.sumSince("owner_time", null, "2099-12-07T00:00:00.000Z")).toBe(18);
    expect(await u.sumSince("owner_time", null, "2099-12-06T00:00:00.000Z")).toBe(22);
    expect(await u.sumSince("spend", ["review"], "2099-12-01T00:00:00.000Z")).toBe(0);
    expect(await u.sumForChange("owner_time", "chg-w")).toBe(18);
    expect(await u.sumForChange("owner_time", "chg-ingen")).toBe(0);
    expect(await u.sumForChange("spend", "chg-w")).toBe(0);
  });

  it("C2: kategoritak og totaltak håndheves mot ekte forbruk (radar 30 av 100; eval 40 av 200; totalt 70 av 1000)", async () => {
    const lock = new BudgetLock(CAPS, new ChangeLedger(appPool), clock, new UsageLedger(appPool));
    expect(await lock.checkCategorySpend("radar", 70)).toMatchObject({ allowed: true, used: 30, limit: 100, remaining: 0, scope: "category:radar" });
    expect(await lock.checkCategorySpend("radar", 71)).toMatchObject({ allowed: false, reason: "budget_exhausted", used: 30, limit: 100, scope: "category:radar" });
    expect(await lock.checkCategorySpend("eval", 160)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await lock.checkCategorySpend("eval", 161)).toMatchObject({ allowed: false, scope: "category:eval" });
    const tight = new BudgetLock({ ...CAPS, max_evolution_cost_ore_per_month: 100 }, new ChangeLedger(appPool), clock, new UsageLedger(appPool));
    expect(await tight.checkCategorySpend("shadow", 31)).toMatchObject({ allowed: false, scope: "total", used: 70, limit: 100 });
  });

  it("C3: eier-tid: uke (mandag 7. desember, ikke søndagens 4 min) og pr endring mot ekte forbruk", async () => {
    const lock = new BudgetLock(CAPS, new ChangeLedger(appPool), clock, new UsageLedger(appPool));
    expect(await lock.checkOwnerTime(102)).toMatchObject({ allowed: true, used: 18, limit: 120, remaining: 0, scope: "week" });
    expect(await lock.checkOwnerTime(103)).toMatchObject({ allowed: false, scope: "week", used: 18 });
    expect(await lock.checkOwnerTime(2, "chg-w")).toMatchObject({ allowed: true, scope: "change", used: 18, limit: 20, remaining: 0 });
    expect(await lock.checkOwnerTime(3, "chg-w")).toMatchObject({ allowed: false, scope: "change", used: 18, limit: 20 });
    expect(await lock.checkOwnerTime(20, "chg-ny")).toMatchObject({ allowed: true });
  });

  it("C4: deploys pr time og døgn mot ekte endringsregister (rader med eksplisitt tid)", async () => {
    const dep = (at: string, id: string, cls = "E2") => adminPool.query(
      `INSERT INTO evolution_change_ledger (change_id, change_class, decision, constitution_digest, subject, paths, branch, head_sha, evidence, recorded_by, at, prev_hash, entry_hash)
       VALUES ($1, $2, 'deployed', $3, 's', '{}', 'b', $4, $5, 'p', $6::timestamptz, '', '')`,
      [id, cls, DIGEST, "e".repeat(40), cls === "E1" ? '{"ci_green":true}' : '{"approved_by":"o","approved_head_sha":"' + "e".repeat(40) + '"}', at]);
    await dep("2099-12-09T11:10:00Z", "dep-a");              // samme døgn, FORRIGE time
    const ledger = new ChangeLedger(appPool);
    const lock = new BudgetLock(CAPS, ledger, clock, new UsageLedger(appPool));
    expect(await lock.checkDeployHour()).toMatchObject({ allowed: true, kind: "deploy_hour", used: 0, limit: 2 });
    expect(await lock.checkDeploy()).toMatchObject({ allowed: true, kind: "deploy", used: 1, limit: 3, remaining: 2 });
    await dep("2099-12-09T12:05:00Z", "dep-b");              // denne timen
    await dep("2099-12-09T12:20:00Z", "dep-c", "E1");        // denne timen
    expect(await lock.checkDeployHour()).toMatchObject({ allowed: false, kind: "deploy_hour", reason: "budget_exhausted", used: 2, limit: 2 });
    expect(await lock.checkDeploy()).toMatchObject({ allowed: false, kind: "deploy" }); // 3 av 3 i døgnet
    // en time senere er timevinduet tomt igjen, men døgnet er fortsatt fullt
    const later = new BudgetLock(CAPS, ledger, () => new Date("2099-12-09T13:00:00.000Z"), new UsageLedger(appPool));
    expect(await later.checkDeployHour()).toMatchObject({ allowed: true, used: 0 });
    expect(await later.checkDeploy()).toMatchObject({ allowed: false, kind: "deploy" });
  });
});
