import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMemoryTransaction } from "@jarvis/memory";
import { seedTenant, startVisionDb, type VisionDb } from "../../../modules/vision/test/support/harness.ts";
import { currentDbLimits, limitedPool, runWithDbLimits } from "../src/vision-db-limits.ts";

/**
 * WP-G3 (D-465), mikro-runde 3 (review delta2 B LOW-E2): databasegrenser (`statement_timeout`/`lock_timeout`) for vedlikeholdets egne transaksjoner, uten å røre den delte `createPool`. Mot en EKTE Postgres:
 * grensene settes med `SET LOCAL` i hver transaksjon som åpnes innenfor `runWithDbLimits` (også enkeltspørringer via `pool.query`), de slår faktisk til (57014 / 55P03) i stedet for å vente for alltid,
 * de lekker aldri ut av omfanget eller mellom samtidige omfang, og utenfor omfanget er poolen uendret.
 */
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let pool: pg.Pool;

const pause = (ms: number): Promise<"timeout"> => new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
const show = (target: pg.Pool, name: "statement_timeout" | "lock_timeout"): Promise<string> =>
  withMemoryTransaction(target, T.tenant, ["home"], async (client) => ((await client.query(`SHOW ${name}`)).rows[0] as Record<string, string>)[name] as string);

beforeAll(async () => {
  db = await startVisionDb("g3dbl");
  T = await seedTenant(db, "g3dbl-t");
  pool = limitedPool(db.app);
}, 240_000);

afterAll(async () => {
  await db?.stop();
}, 120_000);

describe("utenfor omfanget er poolen gjennomsiktig", () => {
  it("ingen grenser (SHOW = 0), samme svar som den rå poolen, og poolens øvrige grensesnitt virker (tellere, hendelser, connect/release)", async () => {
    expect(currentDbLimits()).toBeUndefined();
    expect(await show(pool, "statement_timeout")).toBe("0");
    expect(await show(pool, "lock_timeout")).toBe("0");
    expect((await pool.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    expect((await pool.query("SELECT $1::int AS n", [42])).rows).toEqual([{ n: 42 }]);
    expect(typeof pool.totalCount).toBe("number");
    expect(pool.totalCount).toBe(db.app.totalCount);
    expect(typeof pool.on).toBe("function");
    expect(typeof pool.end).toBe("function");
    const client = await pool.connect();
    expect(typeof client.release).toBe("function");
    expect((await client.query("SELECT 2 AS two")).rows).toEqual([{ two: 2 }]);
    client.release();
  });
});

describe("innenfor omfanget får HVER transaksjon grensene (SET LOCAL), og ingenting lekker ut", () => {
  it("withMemoryTransaction, BEGIN med isolasjonsnivå og små bokstaver, og enkeltspørringer via pool.query får grensene; etter omfanget er alle forbindelser uendret (0)", async () => {
    const limits = { statementTimeoutMs: 12_345, lockTimeoutMs: 6_789 };
    await runWithDbLimits(limits, async () => {
      expect(currentDbLimits()).toEqual(limits);
      expect(await show(pool, "statement_timeout")).toBe("12345ms");
      expect(await show(pool, "lock_timeout")).toBe("6789ms");
      const direct = await pool.query(`SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`);
      expect(direct.rows[0]).toEqual({ s: "12345ms", l: "6789ms" });
      for (const begin of ["BEGIN ISOLATION LEVEL REPEATABLE READ", "begin", "  BEGIN"]) {
        const client = await pool.connect();
        try {
          await client.query(begin);
          const row = (await client.query(`SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`)).rows[0];
          expect(row, begin).toEqual({ s: "12345ms", l: "6789ms" });
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
      // en spørring som ikke er BEGIN (en vanlig setning utenfor transaksjon på en rå forbindelse) får ingenting ekstra
      const raw = await pool.connect();
      try {
        expect((await raw.query(`SELECT current_setting('statement_timeout') AS s`)).rows[0]).toEqual({ s: "0" });
      } finally {
        raw.release();
      }
    });
    expect(currentDbLimits()).toBeUndefined();
    // Ingen lekkasje: mange samtidige transaksjoner utenfor omfanget (flere forbindelser i poolen) har ingen grenser, og heller ikke en enkeltspørring.
    const after = await Promise.all(Array.from({ length: 12 }, () => show(pool, "statement_timeout")));
    expect(after).toEqual(Array.from({ length: 12 }, () => "0"));
    expect((await Promise.all(Array.from({ length: 6 }, () => pool.query(`SELECT current_setting('lock_timeout') AS l`)))).map((r) => r.rows[0])).toEqual(Array.from({ length: 6 }, () => ({ l: "0" })));
  });

  it("samtidige omfang er isolert fra hverandre og fra kode utenfor omfanget (AsyncLocalStorage)", async () => {
    const [a, b, none] = await Promise.all([
      runWithDbLimits({ statementTimeoutMs: 1_111, lockTimeoutMs: 0 }, async () => { await pause(30); return show(pool, "statement_timeout"); }),
      runWithDbLimits({ statementTimeoutMs: 2_222, lockTimeoutMs: 0 }, async () => { await pause(10); return show(pool, "statement_timeout"); }),
      (async () => { await pause(20); return show(pool, "statement_timeout"); })()
    ]);
    expect([a, b, none]).toEqual(["1111ms", "2222ms", "0"]);
  });

  it("ugyldige grenser avvises (negativ, ikke-heltall, NaN, uendelig, over int4), 0 er «ingen grense» og godtas", async () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => runWithDbLimits({ statementTimeoutMs: bad, lockTimeoutMs: 0 }, async () => undefined), `statement ${bad}`).toThrow("vision_db_limits_invalid");
      expect(() => runWithDbLimits({ statementTimeoutMs: 0, lockTimeoutMs: bad }, async () => undefined), `lock ${bad}`).toThrow("vision_db_limits_invalid");
    }
    await runWithDbLimits({ statementTimeoutMs: 0, lockTimeoutMs: 0 }, async () => {
      expect(await show(pool, "statement_timeout")).toBe("0");
    });
    await runWithDbLimits({ statementTimeoutMs: 2_147_483_647, lockTimeoutMs: 2_147_483_647 }, async () => undefined);
  });
});

describe("grensene slår faktisk til (i stedet for å vente for alltid)", () => {
  it("statement_timeout: en langvarig setning avbrytes med 57014 (i en transaksjon og som enkeltspørring), og forbindelsen er brukbar etterpå; uten omfang kjører den ferdig", async () => {
    for (const run of [
      (): Promise<unknown> => withMemoryTransaction(pool, T.tenant, ["home"], (client) => client.query("SELECT pg_sleep(20)")),
      (): Promise<unknown> => pool.query("SELECT pg_sleep(20)")
    ]) {
      const started = Date.now();
      await expect(runWithDbLimits({ statementTimeoutMs: 300, lockTimeoutMs: 0 }, run)).rejects.toMatchObject({ code: "57014" });
      expect(Date.now() - started, "avbrutt av grensen, ikke etter 20 s").toBeLessThan(10_000);
    }
    expect((await pool.query("SELECT 7 AS seven")).rows).toEqual([{ seven: 7 }]); // ingen forgiftet forbindelse
    const slowButFree = Date.now();
    await pool.query("SELECT pg_sleep(0.7)"); // utenfor omfanget: ingen grense (den samme setningen ville blitt avbrutt av en 300 ms-grense)
    expect(Date.now() - slowButFree).toBeGreaterThanOrEqual(600);
  }, 60_000);

  it("lock_timeout: en forlatt tabell-lås gir 55P03 etter grensen i stedet for en evig venting; uten omfang VENTER samme spørring (kontroll), og fullfører når låsen slippes", async () => {
    const blocker = await db.admin.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE vision_snapshots IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      await expect(
        runWithDbLimits({ statementTimeoutMs: 0, lockTimeoutMs: 400 }, () => withMemoryTransaction(pool, T.tenant, ["home"], (client) => client.query("SELECT 1 FROM vision_snapshots LIMIT 1")))
      ).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - started).toBeLessThan(10_000);
      // enkeltspørring via pool.query: samme grense
      await expect(runWithDbLimits({ statementTimeoutMs: 0, lockTimeoutMs: 400 }, () => pool.query("SELECT 1 FROM vision_snapshots LIMIT 1"))).rejects.toMatchObject({ code: "55P03" });
      // KONTROLL: uten omfang venter den samme spørringen (grensen er det som avslutter ventingen) og fullfører når låsen slippes.
      const unlimited = withMemoryTransaction(pool, T.tenant, ["home"], (client) => client.query("SELECT 1 FROM vision_snapshots LIMIT 1"));
      expect(await Promise.race([unlimited.then(() => "done" as const), pause(1_200)])).toBe("timeout");
      await blocker.query("ROLLBACK");
      await expect(unlimited).resolves.toBeDefined();
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    expect((await pool.query("SELECT 8 AS eight")).rows).toEqual([{ eight: 8 }]);
  }, 60_000);
});
