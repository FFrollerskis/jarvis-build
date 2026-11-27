import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-OPS2a fiks-runde 1 (review B-L10): C14 i UA-0-gaten leser alderen med EN SQL-setning som gaten sender gjennom `docker compose exec postgres psql`. Gate-testene bruker en falsk docker som svarer på en delstreng
 * (`FROM incident_producer_runs WHERE producer = 'watchdog'`), så selve SQL-en ble aldri kjørt: `max -> min`, snudd fortegn og `OR producer = 'scheduler'` overlevde alle mutanter. Denne testen trekker EKSAKT den SQL-en ut av gaten og
 * kjører den mot ekte Postgres. Hver måling skjer i én transaksjon (`BEGIN ... ROLLBACK`), så `now()` er det samme for innsettingen og spørringen og alderen er eksakt (ingen tidsflakiness).
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GATE = readFileSync(join(ROOT, "ops/acceptance/nas-ua0-gate.sh"), "utf8");
const SQL = GATE.match(/wd_age="\$\(psqlq "([^"]+)"/)?.[1] ?? "";
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-fix1-c14-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-fix1-a','A','business'), ('t-fix1-b','B','business')`);
}, 240_000);
afterAll(async () => {
  await admin?.end();
  await stop?.();
}, 120_000);

type Row = { tenant: string; producer: string; offset: string };
/** Setter inn radene (`last_started_at = now() + offset`) og kjører gatens SQL i SAMME transaksjon, rullet tilbake etterpå. Returnerer det psql ville skrevet (`-tA`): tom streng for NULL. */
async function age(rows: Row[]): Promise<string> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(`INSERT INTO incident_producer_runs (tenant_id, producer, last_started_at, last_status) VALUES ($1, $2, now() + $3::interval, 'ok')`, [r.tenant, r.producer, r.offset]);
    }
    const res = await client.query(SQL);
    const value = (Object.values(res.rows[0] ?? {})[0] ?? null) as unknown;
    return value === null ? "" : String(value);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

describe("C14-SQL (eksakt fra nas-ua0-gate.sh) mot ekte Postgres", () => {
  it("SQL-en ble funnet i gaten og har den forventede formen (så en endret gate gir en rød test her, ikke en stille bortfalt vakt)", () => {
    expect(SQL.length).toBeGreaterThan(40);
    expect(SQL).toContain("FROM incident_producer_runs WHERE producer = 'watchdog'");
    expect(SQL).toMatch(/floor\(extract\(epoch FROM \(now\(\) - max\(last_started_at\)\)\)\)::bigint/);
  });

  it("ingen rad gir NULL (psql skriver tom linje: gaten sier UNKNOWN, aldri PASS)", async () => {
    expect(await age([])).toBe("");
  });

  it("alder i hele sekunder: 600 s -> 600, 0 s -> 0, 301 s -> 301 (grensene i gaten er 300 og 900)", async () => {
    expect(await age([{ tenant: "t-fix1-a", producer: "watchdog", offset: "-600 seconds" }])).toBe("600");
    expect(await age([{ tenant: "t-fix1-a", producer: "watchdog", offset: "0 seconds" }])).toBe("0");
    expect(await age([{ tenant: "t-fix1-a", producer: "watchdog", offset: "-301 seconds" }])).toBe("301");
  });

  it("fortegnet er `nå minus siste tikk`: et tikk 90 s frem i tid gir -90 (klokkeavvik, ikke +90)", async () => {
    expect(await age([{ tenant: "t-fix1-a", producer: "watchdog", offset: "90 seconds" }])).toBe("-90");
    expect(await age([{ tenant: "t-fix1-a", producer: "watchdog", offset: "-90 seconds" }])).toBe("90");
  });

  it("brøkdeler rundes NED (`floor`): 300,9 s -> 300 (fortsatt PASS i gaten); 300,0 s -> 300", async () => {
    expect(await age([{ tenant: "t-fix1-a", producer: "watchdog", offset: "-300.9 seconds" }])).toBe("300");
    expect(await age([{ tenant: "t-fix1-a", producer: "watchdog", offset: "-300 seconds" }])).toBe("300");
  });

  it("flere tenants: `max(last_started_at)` = det SISTE tikket gjelder (en gammel rad skjuler ikke et ferskt, og omvendt ikke et gammelt et ferskt) - ikke `min`", async () => {
    const a = { tenant: "t-fix1-a", producer: "watchdog", offset: "-600 seconds" };
    const b = { tenant: "t-fix1-b", producer: "watchdog", offset: "-5 seconds" };
    expect(await age([a, b])).toBe("5");
    expect(await age([b, a])).toBe("5");
  });

  it("kun `watchdog`-raden teller: en fersk `scheduler`-rad (eller en annen produsent) maskerer aldri en gammel vakthund, og alene gir den NULL", async () => {
    const wd = { tenant: "t-fix1-a", producer: "watchdog", offset: "-600 seconds" };
    for (const other of ["scheduler", "deployment", "sentry", "slo", "provider", "infra_execution"]) {
      expect(await age([wd, { tenant: "t-fix1-a", producer: other, offset: "-2 seconds" }]), other).toBe("600");
      expect(await age([{ tenant: "t-fix1-a", producer: other, offset: "-2 seconds" }]), other).toBe("");
    }
  });
});
