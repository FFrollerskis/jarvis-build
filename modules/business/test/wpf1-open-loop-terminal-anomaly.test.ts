import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { OpenLoopService } from "../src/open-loop-service.ts";

/**
 * WP-F1 (D-453, JARVIS-072): pengeavvik som blir stående på en TERMINAL intensjon (oppgjort/feilet/kansellert) skal fortsatt vises som open loop - avstemmingens egne funn
 * (`RECONCILE_*`) og leverandørkonflikter/ukjent innsendingsutfall/refusjons- og capture-beløp som ikke stemmer. Opprettelsesflagg på en avsluttet intensjon (f.eks. manglende
 * leverandørreferanse ved opprettelse) gir fortsatt INGEN loop (uendret oppførsel, jf. `open-loop-finance.test.ts`). Ren SQL-fixture direkte mot `payment_intents`.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let openLoops: OpenLoopService;
const TENANT = "tenant-ol-wpf1";

async function intent(state: string, flags: string[]): Promise<string> {
  const id = `fin-pi-${randomUUID()}`;
  await withMemoryTransaction(appPool, TENANT, ["business"], (client) =>
    client.query(
      `INSERT INTO payment_intents (payment_intent_id, tenant_id, memory_space_id, idempotency_key, purpose, amount_ore, vendor_name, account_code, state, anomaly_flags, owner_person_id)
       VALUES ($1, $2, 'business', $1, 'Test', 10000, 'Leverandør', '6540', $3, $4, 'person-tobias')`,
      [id, TENANT, state, JSON.stringify(flags)]
    )
  );
  return id;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ol-wpf1-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_ol_wpf1 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_ol_wpf1");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'OL wpf1', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias', 'Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias', '${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-wpf1-business', '${TENANT}', 'business');
  `);
  appPool = createPool({ ...base, user: "jarvis_ol_wpf1", password: "pw2" });
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

describe("terminal intensjon med pengeavvik vises; opprettelsesflagg gjør det ikke", () => {
  it("avstemmingens egne funn og leverandørkonflikter vises på oppgjort/feilet/kansellert intensjon", async () => {
    const shown: Array<[string, string]> = [
      ["settled", "RECONCILE_PROVIDER_AMOUNT_MISMATCH"], ["settled", "WEBHOOK_STATE_CONFLICT"], ["failed", "SUBMIT_OUTCOME_UNKNOWN"], ["cancelled", "UNKNOWN_PROVIDER_OUTCOME"],
      ["settled", "REFUND_AMOUNT_CONFLICT"], ["settled", "CAPTURE_AMOUNT_CONFLICT"], ["settled", "DUPLICATE_PROVIDER_EFFECT"], ["settled", "PROVIDER_STATE_CONFLICT"]
    ];
    const ids = new Map<string, string>();
    for (const [state, flag] of shown) ids.set(`${state}:${flag}`, await intent(state, [flag]));
    const result = await openLoops.detectPaymentAnomalies(TENANT, "business");
    expect(result.detected).toBeGreaterThanOrEqual(shown.length);
    const loops = await openLoops.listOpenLoops(TENANT, "business", "open");
    for (const [key, id] of ids) expect(loops.find((l) => l.payment_intent_id === id)?.loop_type, key).toBe("payment_intent_anomaly");
  });

  it("opprettelsesflagg og ukjente flagg på en terminal intensjon gir fortsatt INGEN loop; en ikke-terminal intensjon med hvilket som helst flagg gir loop (uendret)", async () => {
    const creationFlag = await intent("settled", ["vendor_provider_ref_missing_at_creation", "counter_account_code_missing_at_creation"]);
    const unknownFlag = await intent("failed", ["NOE_HELT_ANNET"]);
    const activeWithAnyFlag = await intent("submitted", ["NOE_HELT_ANNET"]);
    await openLoops.detectPaymentAnomalies(TENANT, "business");
    const loops = await openLoops.listOpenLoops(TENANT, "business", "open");
    expect(loops.find((l) => l.payment_intent_id === creationFlag)).toBeUndefined();
    expect(loops.find((l) => l.payment_intent_id === unknownFlag)).toBeUndefined();
    expect(loops.find((l) => l.payment_intent_id === activeWithAnyFlag)?.loop_type).toBe("payment_intent_anomaly");
  });

  it("når avstemmingen fjerner flagget, autolukkes loopen", async () => {
    const id = await intent("settled", ["RECONCILE_OVER_REFUNDED"]);
    await openLoops.detectPaymentAnomalies(TENANT, "business");
    expect((await openLoops.listOpenLoops(TENANT, "business", "open")).some((l) => l.payment_intent_id === id)).toBe(true);
    await withMemoryTransaction(appPool, TENANT, ["business"], (client) => client.query(`UPDATE payment_intents SET anomaly_flags = '[]'::jsonb WHERE payment_intent_id = $1`, [id]));
    const after = await openLoops.detectPaymentAnomalies(TENANT, "business");
    expect(after.auto_resolved).toBeGreaterThanOrEqual(1);
    expect((await openLoops.listOpenLoops(TENANT, "business", "open")).some((l) => l.payment_intent_id === id)).toBe(false);
  });
});
