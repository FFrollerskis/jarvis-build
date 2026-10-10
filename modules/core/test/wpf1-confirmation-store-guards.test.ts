import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfirmationStore, CONFIRMATION_TTL_MS, bindingHash, callFingerprint, createPool, runMigrations, type CanonicalCall } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-F1, uavhengig review (PR #321) - testgap fra mutantene M24/M25: `approveAndTake` har TRE uavhengige vern (SQL-filter på utløp og person, gjenberegnet fingeravtrykk, binding-hash med utløp).
 * De eksisterende testene "simulerte" utløp ved å flytte `expires_at` i databasen, men da stopper binding-hashen (som inneholder utløpet) kallet uansett - SQL-filteret `expires_at > now()` var maskert.
 * Tilsvarende er personbindingen maskert av fingeravtrykket (som inneholder person-id). Her ISOLERES hvert SQL-vern: raden er laget slik at fingeravtrykk og binding-hash er KONSISTENTE med den som
 * godkjenner, så den ENESTE tingen som kan stoppe kallet er SQL-filteret. Fjernes filteret, blir testen rød.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-wpf1-conf";
const OWNER = "person-wpf1-conf-owner";
const OTHER = "person-wpf1-conf-other";
const DEVICE = "dev-wpf1-conf";

const call: CanonicalCall = { tool_id: "finance", action: "submit_payment_intent", parameters: { tenant_id: TENANT, payment_intent_id: "fin-pi-conf-1" } };
const owner = { tenant_id: TENANT, person_id: OWNER, device_id: DEVICE };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-conf-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1_conf LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1_conf");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPF1 conf', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier'), ('${OTHER}', 'Annen');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT}'), ('${OTHER}', '${TENANT}');
  `);
  appPool = createPool({ ...base, user: "jarvis_wpf1_conf", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

describe("M24: NATURLIG utløp stoppes av SQL-filteret `expires_at > now()` (ikke av binding-hashen)", () => {
  it("en bekreftelse som ble opprettet for mer enn TTL siden (konsistent fingeravtrykk og binding) kan ikke godkjennes", async () => {
    // Klokken står 10 minutter bak: raden får et KONSISTENT utløp (opprettelse + 5 min = 5 minutter siden), uten at noe i databasen er tuklet med.
    const past = new ConfirmationStore(appPool, () => new Date(Date.now() - 2 * CONFIRMATION_TTL_MS));
    const created = await past.requestPending(call, owner, ["wpf1"]);
    const row = (await adminPool.query("SELECT expires_at < now() AS expired, status FROM action_confirmations WHERE confirmation_id = $1", [created.confirmation_id])).rows[0] as { expired: boolean; status: string };
    expect(row).toEqual({ expired: true, status: "pending" });
    const live = new ConfirmationStore(appPool);
    expect(await live.approveAndTake(owner, created.confirmation_id)).toBeNull();
    expect((await adminPool.query("SELECT status FROM action_confirmations WHERE confirmation_id = $1", [created.confirmation_id])).rows[0]).toEqual({ status: "pending" }); // ikke forbrukt
    expect(await live.peekPending(owner, created.confirmation_id)).toBeNull();
  });

  it("kontroll: en ferskt opprettet bekreftelse godkjennes nøyaktig én gang med kallet slik det ble bundet", async () => {
    const store = new ConfirmationStore(appPool);
    const created = await store.requestPending(call, owner, ["wpf1"]);
    expect(await store.approveAndTake(owner, created.confirmation_id)).toEqual({ confirmation_id: created.confirmation_id, tool_id: call.tool_id, action: call.action, parameters: call.parameters });
    expect(await store.approveAndTake(owner, created.confirmation_id)).toBeNull(); // engangs
  });
});

describe("M25: personbindingen i SQL-filteret `person_id = $3` isoleres (fingeravtrykket gjør det ellers umulig å se)", () => {
  /** Setter inn en bekreftelse eid av `rowOwner`, men med fingeravtrykk og binding-hash beregnet for `boundTo` - slik at kun SQL-filteret kan skille dem. */
  async function craft(rowOwner: string, boundTo: string): Promise<string> {
    const id = `conf-${randomUUID()}`;
    const nonce = randomBytes(16).toString("hex");
    const expires = new Date(Date.now() + CONFIRMATION_TTL_MS);
    const fingerprint = callFingerprint(call, { tenant_id: TENANT, person_id: boundTo, device_id: DEVICE });
    await adminPool.query(
      `INSERT INTO action_confirmations
         (confirmation_id, tenant_id, person_id, device_id, session_id, tool_id, action, call_fingerprint, binding_hash, nonce, summary, taint_reasons, expires_at, parameters)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, '{}'::jsonb, ARRAY['wpf1']::text[], $10, $11)`,
      [id, TENANT, rowOwner, DEVICE, call.tool_id, call.action, fingerprint, bindingHash(fingerprint, expires.toISOString(), nonce), nonce, expires, JSON.stringify(call.parameters)]
    );
    return id;
  }

  it("en annen persons bekreftelse (i samme tenant) kan ikke godkjennes av eieren, selv om fingeravtrykk og binding-hash 'passer'", async () => {
    const store = new ConfirmationStore(appPool);
    const id = await craft(OTHER, OWNER); // raden tilhører OTHER, men er bundet som om OWNER ba om den
    expect(await store.approveAndTake(owner, id)).toBeNull();
    expect(await store.peekPending(owner, id)).toBeNull();
    expect((await adminPool.query("SELECT status FROM action_confirmations WHERE confirmation_id = $1", [id])).rows[0]).toEqual({ status: "pending" });
  });

  it("kontroll: samme konstruksjon eid av eieren selv godkjennes (så testen ikke bare 'alltid avviser')", async () => {
    const store = new ConfirmationStore(appPool);
    const id = await craft(OWNER, OWNER);
    expect(await store.approveAndTake(owner, id)).toMatchObject({ confirmation_id: id, tool_id: call.tool_id });
  });
});
