import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  ChangeLedger, GENESIS_HASH, LedgerError, assertLedgerRules, chainHash, verifyChain, type ChangeLedgerInput, type ChangeLedgerRow
} from "../src/index.ts";

/** EV-0 (D-408): endringsregister med hash-kjede - ren logikk + ekte Postgres (migrasjon 075). */
const DIGEST = "a".repeat(64);
const SHA = "b".repeat(40);

const base = (over: Partial<ChangeLedgerInput> = {}): ChangeLedgerInput => ({
  change_id: "pr-1", change_class: "E2", decision: "proposed", constitution_digest: DIGEST, subject: "Endre noe",
  paths: ["apps/api/src/x.ts"], branch: "claude/x", head_sha: SHA, evidence: { tests: "grønn" }, recorded_by: "person-owner", ...over
});
const code = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return (err as LedgerError).code ?? `other:${(err as Error).message}`; }
  return "no_error";
};

describe("A: regler (ren logikk)", () => {
  it("A1: E3 kan aldri godkjennes, merges eller deployes", () => {
    for (const decision of ["approved", "merged", "deployed"] as const) {
      expect(code(() => assertLedgerRules(base({ change_class: "E3", decision })))).toBe("ledger_rule_violation");
    }
    for (const decision of ["proposed", "rejected", "blocked"] as const) {
      expect(code(() => assertLedgerRules(base({ change_class: "E3", decision })))).toBe("no_error");
    }
  });

  it("A2: E2 merged krever eier-godkjenning bundet til samme commit", () => {
    expect(code(() => assertLedgerRules(base({ decision: "merged" })))).toBe("ledger_rule_violation");
    expect(code(() => assertLedgerRules(base({ decision: "merged", evidence: { approved_by: "o", approved_head_sha: "c".repeat(40) } })))).toBe("ledger_rule_violation");
    expect(code(() => assertLedgerRules(base({ decision: "merged", evidence: { approved_by: "o", approved_head_sha: SHA } })))).toBe("no_error");
  });

  it("A3: E1 merged krever grønn CI; utført endring krever SHA", () => {
    expect(code(() => assertLedgerRules(base({ change_class: "E1", decision: "merged" })))).toBe("ledger_rule_violation");
    expect(code(() => assertLedgerRules(base({ change_class: "E1", decision: "merged", evidence: { ci_green: true } })))).toBe("no_error");
    expect(code(() => assertLedgerRules(base({ change_class: "E1", decision: "deployed", head_sha: null, evidence: { ci_green: true } })))).toBe("ledger_rule_violation");
  });
});

describe("B: hash-kjede (ren logikk)", () => {
  const mk = (n: number): ChangeLedgerRow[] => {
    const rows: ChangeLedgerRow[] = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= n; i++) {
      const partial = {
        seq: String(i), change_id: `c-${i}`, change_class: "E2", decision: "proposed", constitution_digest: DIGEST, subject: `s${i}`,
        paths: ["a", "b"], branch: "br", head_sha: SHA, evidence: "{}", recorded_by: "p", at_text: "2026-10-06T00:00:00.000000Z", prev_hash: prev
      };
      const row = { ...partial, entry_hash: chainHash(partial) };
      rows.push(row);
      prev = row.entry_hash;
    }
    return rows;
  };

  it("B1: hel kjede er ok; tom kjede er ok", () => {
    expect(verifyChain(mk(5))).toMatchObject({ ok: true, count: 5, broken_seq: null });
    expect(verifyChain([])).toMatchObject({ ok: true, count: 0, head_hash: GENESIS_HASH });
  });

  it("B2: endret felt, fjernet rad, byttet rekkefølge og hull avsløres på riktig seq", () => {
    const edited = mk(4); edited[1] = { ...edited[1]!, subject: "endret" };
    expect(verifyChain(edited)).toMatchObject({ ok: false, broken_seq: "2" });
    const removed = mk(4).filter((r) => r.seq !== "2");
    expect(verifyChain(removed)).toMatchObject({ ok: false, broken_seq: "3" });
    const swapped = mk(3); [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(verifyChain(swapped).ok).toBe(false);
    const truncatedHead = mk(3).slice(1);
    expect(verifyChain(truncatedHead)).toMatchObject({ ok: false, broken_seq: "2" });
  });
});

let adminPool: pg.Pool;
let appPool: pg.Pool;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ledger-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_ledger_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_ledger_test");
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_ledger_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
});

describe("C: ekte Postgres (migrasjon 075)", () => {
  it("C1: append som jarvis_app gir seq 1.., prev_hash-kjede, og TypeScript-hash = databasens hash", async () => {
    const ledger = new ChangeLedger(appPool);
    const a = await ledger.append(base({ change_id: "c1", paths: ["x/æøå.ts", "y.ts"], evidence: { z: 1, a: { q: true } } }));
    const b = await ledger.append(base({ change_id: "c1", decision: "approved", evidence: { approved_by: "o" } }));
    expect(a.seq).toBe("1");
    expect(a.prev_hash).toBe(GENESIS_HASH);
    expect(b.seq).toBe("2");
    expect(b.prev_hash).toBe(a.entry_hash);
    const { entry_hash, ...rest } = a;
    expect(chainHash(rest)).toBe(entry_hash);
    expect(a.evidence).toBe('{"a":{"q":true},"z":1}');
    expect((await ledger.history("c1")).map((r) => r.decision)).toEqual(["proposed", "approved"]);
  });

  it("C2: appen kan ikke velge seq/hash (trigger overstyrer) - rå INSERT med falske verdier gir likevel gyldig kjede", async () => {
    const r = await appPool.query(
      `INSERT INTO evolution_change_ledger (seq, change_id, change_class, decision, constitution_digest, subject, paths, branch, head_sha, evidence, recorded_by, prev_hash, entry_hash)
       VALUES (999, 'forged', 'E2', 'proposed', $1, 's', '{}', 'b', NULL, '{}', 'p', 'fake', 'fake') RETURNING seq::text AS seq, entry_hash`, [DIGEST]);
    expect(r.rows[0].seq).not.toBe("999");
    expect(r.rows[0].entry_hash).not.toBe("fake");
    expect((await new ChangeLedger(appPool).verify()).ok).toBe(true);
  });

  it("C3: UPDATE, DELETE og TRUNCATE nektes - også for superbruker (trigger) og for jarvis_app (grants)", async () => {
    for (const sql of [
      "UPDATE evolution_change_ledger SET subject = 'x' WHERE seq = 1", "DELETE FROM evolution_change_ledger WHERE seq = 1", "TRUNCATE evolution_change_ledger"
    ]) {
      await expect(adminPool.query(sql), `admin ${sql}`).rejects.toThrow(/append_only_table/);
      await expect(appPool.query(sql), `app ${sql}`).rejects.toThrow();
    }
  });

  it("C4: E3 merged nektes av databasen selv (CHECK), selv ved rå INSERT", async () => {
    await expect(adminPool.query(
      `INSERT INTO evolution_change_ledger (change_id, change_class, decision, constitution_digest, subject, paths, branch, evidence, recorded_by, prev_hash, entry_hash)
       VALUES ('e3', 'E3', 'merged', $1, 's', '{}', 'b', '{}', 'p', '', '')`, [DIGEST])).rejects.toThrow(/evolution_ledger_e3_never_executed/);
    await expect(new ChangeLedger(appPool).append(base({ change_class: "E3", decision: "merged" }))).rejects.toMatchObject({ code: "ledger_rule_violation" });
  });

  it("C5: ugyldig input avvises før databasen (feil digest, ugyldig sha)", async () => {
    const ledger = new ChangeLedger(appPool);
    await expect(ledger.append(base({ constitution_digest: "xyz" }))).rejects.toMatchObject({ code: "ledger_invalid_entry" });
    await expect(ledger.append(base({ head_sha: "ZZZ" }))).rejects.toMatchObject({ code: "ledger_invalid_entry" });
  });

  it("C6: 12 samtidige innsettinger gir unike, sammenhengende seq og en gyldig kjede", async () => {
    const ledger = new ChangeLedger(appPool);
    const before = (await ledger.all()).length;
    await Promise.all(Array.from({ length: 12 }, (_, i) => ledger.append(base({ change_id: `par-${i}` }))));
    const rows = await ledger.all();
    expect(rows.length).toBe(before + 12);
    expect(rows.map((r) => Number(r.seq))).toEqual(rows.map((_, i) => i + 1));
    expect(verifyChain(rows).ok).toBe(true);
  });

  it("C7: manipulasjon utenom triggerne (admin deaktiverer trigger og endrer en rad) avsløres av BÅDE databasen og TypeScript", async () => {
    const ledger = new ChangeLedger(appPool);
    const target = (await ledger.all())[1]!;
    const c = await adminPool.connect();
    try {
      await c.query("ALTER TABLE evolution_change_ledger DISABLE TRIGGER evolution_ledger_no_update_delete");
      await c.query("UPDATE evolution_change_ledger SET subject = 'omskrevet historikk' WHERE seq = $1", [target.seq]);
      await c.query("ALTER TABLE evolution_change_ledger ENABLE TRIGGER evolution_ledger_no_update_delete");
    } finally {
      c.release();
    }
    const result = await ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.broken_seq).toBe(target.seq);
    expect((await adminPool.query("SELECT evolution_ledger_verify()::text AS b")).rows[0].b).toBe(target.seq);
  });
});
