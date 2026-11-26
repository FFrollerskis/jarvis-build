import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { FinanceService, ProviderOutcomeUnknownError, type PaymentIntent, type VippsCredentials } from "../src/index.ts";
import { Gate, VippsFake } from "./wpf1-fakes.ts";
const fixtureToken = (...parts: string[]): string => parts.join("-"); // fikstur-tokens bygges sammensatt ved kjøring (aldri en bokstavelig nøkkelform i kilden)

/**
 * WP-FIN2 K5 (D-486, JARVIS-020/072): Vipps penge-tilstand mot ekte embedded Postgres.
 *   (a) `submitVippsCapture`: `captured`-hendelsen og full-oppgjør-sjekken hører til SAMME transaksjon som at capturen settes `settled`. Feiler noe av det,
 *       står ikke capturen igjen som «oppgjort uten hendelse/oppgjør» - feilen går i M-F2-stien (`ProviderOutcomeUnknownError`, retry med samme Idempotency-Key).
 *   (b) en intensjon med oppgjorte (eller uavklarte) captures blir ALDRI `cancelled`: eksplisitt cancel gir en typet feil uten leverandørkall, og en
 *       webhook/oppfrisking som melder TERMINATED/EXPIRED/CANCELLED/ABORTED gir `PROVIDER_STATE_CONFLICT` og intensjonen blir stående.
 * Alle leverandører er testdobler (ingen nettverk).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-fin2-vipps";
const WEBHOOK_SECRET = fixtureToken("vipps", "webhook", "secret", "fixture", "fin2");
const HOST = "jarvis.test";
const PATH = "/webhooks/vipps";
const vippsCreds: VippsCredentials = { clientId: "c", clientSecret: fixtureToken("s", "fixture"), subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-vipps-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_fin2_vipps LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_fin2_vipps");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'FIN2 vipps', 'business')`);
  appPool = createPool({ ...base, user: "jarvis_fin2_vipps", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

function service(vipps: VippsFake): FinanceService {
  return new FinanceService(
    appPool, undefined, undefined, undefined, undefined, undefined,
    { getCredentials: async () => vippsCreds }, () => vipps, () => WEBHOOK_SECRET, () => TENANT
  );
}

async function authorizedIntent(svc: FinanceService, amountOre = 10_000): Promise<PaymentIntent> {
  const intent = await svc.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "FIN2 vipps", amount_ore: amountOre, vendor_name: `Kunde ${randomUUID().slice(0, 6)}`, account_code: "kategori", provider: "vipps"
  });
  await adminPool.query(
    "UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = $1, provider_status = 'AUTHORIZED', provider_status_updated_at = now() - interval '1 hour' WHERE payment_intent_id = $1",
    [intent.payment_intent_id]
  );
  return intent;
}

async function draftCapture(svc: FinanceService, intentId: string, amountOre: number) {
  return svc.createVippsCapture(TENANT, "business", { idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intentId, amount_ore: amountOre });
}

const intentRow = async (id: string) => (await adminPool.query("SELECT state, provider_status, anomaly_flags FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0] as { state: string; provider_status: string; anomaly_flags: string[] };
const captureRow = async (id: string) => (await adminPool.query("SELECT state, anomaly_flags, failure_reason FROM vipps_captures WHERE capture_id = $1", [id])).rows[0] as { state: string; anomaly_flags: string[]; failure_reason: string | null };
/** `anomaly_flagged`-hendelser som bærer et gitt avviksflagg (opprettelsen skriver også en `anomaly_flagged` for manglende leverandørreferanse - den telles ikke). */
const flagEvents = async (id: string, flag: string) =>
  (await adminPool.query("SELECT summary, metadata FROM payment_intent_events WHERE payment_intent_id = $1 AND event_type = 'anomaly_flagged' AND metadata->'anomaly_flags' ? $2", [id, flag])).rows as Array<{ summary: string; metadata: Record<string, unknown> }>;
const eventTypes = async (id: string) => ((await adminPool.query("SELECT event_type FROM payment_intent_events WHERE payment_intent_id = $1 ORDER BY created_at", [id])).rows as Array<{ event_type: string }>).map((r) => r.event_type);

function signedHeaders(raw: Buffer) {
  const date = new Date().toUTCString();
  const contentHash = createHash("sha256").update(raw).digest("base64");
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`POST\n${PATH}\n${date};${HOST};${contentHash}`, "utf8").digest("base64");
  return { host: HOST, xMsDate: date, xMsContentSha256: contentHash, authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}` };
}
async function webhook(svc: FinanceService, reference: string, name: string, extra: Record<string, unknown> = {}) {
  const raw = Buffer.from(JSON.stringify({
    reference, name, amount: { currency: "NOK", value: 10_000 }, timestamp: new Date().toISOString(), idempotencyKey: `wh-${randomUUID()}`, ...extra
  }));
  return svc.ingestVippsWebhookEvent(raw, "POST", PATH, signedHeaders(raw));
}

describe("K5a: capture-oppgjør, hendelse og full-oppgjør-sjekk er ÉN transaksjon", () => {
  it("utløser som feiler `captured`-hendelsen: capturen står IKKE igjen som `settled`; ukjent utfall + flagg; retry med SAMME Idempotency-Key fullfører og oppgjør skjer", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 10_000);

    await adminPool.query(`
      CREATE OR REPLACE FUNCTION fin2_fail_captured_event() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.event_type = 'captured' THEN RAISE EXCEPTION 'fin2_forced_event_failure'; END IF; RETURN NEW; END $f$`);
    await adminPool.query("CREATE TRIGGER fin2_fail_captured BEFORE INSERT ON payment_intent_events FOR EACH ROW EXECUTE FUNCTION fin2_fail_captured_event()");
    try {
      const first = await svc.submitVippsCapture(TENANT, "business", capture.capture_id).catch((err: unknown) => err);
      // leverandøren HAR utført capturen (kallet er sendt), men lokal lagring feilet: UKJENT utfall, aldri en stille `failed` og aldri en halv lagring
      expect(first).toBeInstanceOf(ProviderOutcomeUnknownError);
      expect((first as Error).message).toMatch(/^outcome_unknown:provider_call_completed_local_write_failed/);
      const afterFailure = await captureRow(capture.capture_id);
      expect(afterFailure.state).not.toBe("settled"); // ikke «oppgjort» uten hendelse og uten full-oppgjør-sjekk
      expect(afterFailure.anomaly_flags).toContain("SUBMIT_OUTCOME_UNKNOWN");
      expect((await intentRow(intent.payment_intent_id)).state).toBe("provider_acknowledged");
      expect(await eventTypes(intent.payment_intent_id)).not.toContain("captured");
    } finally {
      await adminPool.query("DROP TRIGGER fin2_fail_captured ON payment_intent_events");
    }

    const retried = await svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    expect(retried.state).toBe("settled");
    // samme Idempotency-Key begge ganger: leverandøren slår sammen kallene (ingen dobbel capture)
    expect(vipps.captureCalls).toHaveLength(2);
    expect(vipps.captureCalls[0]!.idempotencyKey).toBe(`vipps-capture:${capture.capture_id}`);
    expect(vipps.captureCalls[1]!.idempotencyKey).toBe(vipps.captureCalls[0]!.idempotencyKey);
    expect((await captureRow(capture.capture_id)).anomaly_flags).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect((await intentRow(intent.payment_intent_id)).state).toBe("settled");
    const events = await eventTypes(intent.payment_intent_id);
    expect(events.filter((e) => e === "captured")).toHaveLength(1);
    expect(events.filter((e) => e === "settled")).toHaveLength(1);
  });

  it("utløser som feiler `settled`-hendelsen (full-oppgjør-sjekken): capturen rulles tilbake sammen med den, intensjonen står uendret, retry fullfører", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 5_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 5_000);
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION fin2_fail_settled_event() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.event_type = 'settled' THEN RAISE EXCEPTION 'fin2_forced_settled_failure'; END IF; RETURN NEW; END $f$`);
    await adminPool.query("CREATE TRIGGER fin2_fail_settled BEFORE INSERT ON payment_intent_events FOR EACH ROW EXECUTE FUNCTION fin2_fail_settled_event()");
    try {
      await expect(svc.submitVippsCapture(TENANT, "business", capture.capture_id)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
      expect((await captureRow(capture.capture_id)).state).not.toBe("settled");
      expect((await intentRow(intent.payment_intent_id)).state).toBe("provider_acknowledged");
    } finally {
      await adminPool.query("DROP TRIGGER fin2_fail_settled ON payment_intent_events");
    }
    expect((await svc.submitVippsCapture(TENANT, "business", capture.capture_id)).state).toBe("settled");
    expect((await intentRow(intent.payment_intent_id)).state).toBe("settled");
  });

  it("samtidig CAPTURED-webhook MENS capture-kallet pågår: capturen settes, intensjonen oppgjøres, og `settled`/`captured` skrives nøyaktig én gang", async () => {
    const vipps = new VippsFake();
    vipps.gate = new Gate();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 10_000);

    const submit = svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    const t0 = Date.now();
    while (vipps.captureCalls.length === 0) {
      if (Date.now() - t0 > 5_000) throw new Error("capture_call_never_started");
      await new Promise((r) => setTimeout(r, 10));
    }
    // CAPTURED-hendelsen er NYERE og kommer før lokal lagring: ingen radlås holdes over leverandørkallet, så den behandles uten å vente
    expect((await webhook(svc, intent.payment_intent_id, "CAPTURED")).status).toBe("processed");
    expect((await intentRow(intent.payment_intent_id)).state).toBe("provider_acknowledged"); // capturen er ikke lagret ennå
    vipps.gate.open();
    const done = await submit;
    expect(done.state).toBe("settled");
    expect((await intentRow(intent.payment_intent_id)).state).toBe("settled");
    const events = await eventTypes(intent.payment_intent_id);
    expect(events.filter((e) => e === "settled")).toHaveLength(1);
    expect(events.filter((e) => e === "captured")).toHaveLength(1);
  });

  it("20 runder: submit og CAPTURED-webhooks i kappløp gir alltid ÉN `settled`-hendelse og en oppgjort intensjon", async () => {
    for (let round = 0; round < 20; round++) {
      const vipps = new VippsFake();
      const svc = service(vipps);
      const intent = await authorizedIntent(svc, 4_000);
      const capture = await draftCapture(svc, intent.payment_intent_id, 4_000);
      const results = await Promise.allSettled([
        svc.submitVippsCapture(TENANT, "business", capture.capture_id),
        webhook(svc, intent.payment_intent_id, "CAPTURED"),
        webhook(svc, intent.payment_intent_id, "CAPTURED"),
        webhook(svc, intent.payment_intent_id, "CAPTURED")
      ]);
      expect(results.every((r) => r.status === "fulfilled"), `runde ${round}: ${JSON.stringify(results.filter((r) => r.status === "rejected"))}`).toBe(true);
      expect((await intentRow(intent.payment_intent_id)).state, `runde ${round}`).toBe("settled");
      expect((await captureRow(capture.capture_id)).state, `runde ${round}`).toBe("settled");
      expect((await eventTypes(intent.payment_intent_id)).filter((e) => e === "settled"), `runde ${round}`).toHaveLength(1);
    }
  }, 120_000);

  it("delvis capture lar intensjonen stå `provider_acknowledged` og skriver `captured` (ingen `settled`)", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 2_500);
    expect((await svc.submitVippsCapture(TENANT, "business", capture.capture_id)).state).toBe("settled");
    expect((await intentRow(intent.payment_intent_id)).state).toBe("provider_acknowledged");
    expect(await eventTypes(intent.payment_intent_id)).toContain("captured");
    expect(await eventTypes(intent.payment_intent_id)).not.toContain("settled");
  });

  it("en retry etter fullført capture gir ingen ny hendelse (idempotent no-op)", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 3_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 3_000);
    await svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    await svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    expect(vipps.captureCalls).toHaveLength(1);
    expect((await eventTypes(intent.payment_intent_id)).filter((e) => e === "captured")).toHaveLength(1);
  });
});

describe("K5b: aldri `cancelled` med oppgjorte captures", () => {
  async function partiallyCaptured(svc: FinanceService, vipps: VippsFake) {
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 2_500);
    await svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    expect(vipps.captureCalls).toHaveLength(1);
    return { intent, capture };
  }

  it("eksplisitt cancel etter delvis capture: typet feil, INGEN leverandørkall, intensjonen uendret", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const { intent } = await partiallyCaptured(svc, vipps);
    const err = await svc.cancelVippsPayment(TENANT, "business", intent.payment_intent_id).catch((e: unknown) => e);
    expect((err as Error).name).toBe("CancelBlockedByCapturesError");
    expect((err as Error).message).toBe(`cancel_blocked_by_captures:${intent.payment_intent_id}:settled_captures`);
    expect(vipps.cancelCalls).toHaveLength(0);
    const row = await intentRow(intent.payment_intent_id);
    expect(row.state).toBe("provider_acknowledged");
    expect(row.provider_status).toBe("AUTHORIZED");
  });

  it("kontroll: uten captures kanselleres intensjonen som før (leverandørkall + `cancelled`)", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const cancelled = await svc.cancelVippsPayment(TENANT, "business", intent.payment_intent_id);
    expect(cancelled.state).toBe("cancelled");
    expect(vipps.cancelCalls).toHaveLength(1);
  });

  it("en mislykket/avbrutt capture (failed/cancelled) teller ikke: cancel går gjennom", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 1_000);
    await adminPool.query("UPDATE vipps_captures SET state = 'failed', failed_at = now() WHERE capture_id = $1", [capture.capture_id]);
    expect((await svc.cancelVippsPayment(TENANT, "business", intent.payment_intent_id)).state).toBe("cancelled");
  });

  it("en capture i flukt (`submitted`) eller med ukjent utfall (flagget `SUBMIT_OUTCOME_UNKNOWN`) blokkerer også cancel - pengene kan allerede være tatt", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const inFlight = await authorizedIntent(svc, 10_000);
    const c1 = await draftCapture(svc, inFlight.payment_intent_id, 1_000);
    await adminPool.query("UPDATE vipps_captures SET state = 'submitted', submitted_at = now() WHERE capture_id = $1", [c1.capture_id]);
    const e1 = await svc.cancelVippsPayment(TENANT, "business", inFlight.payment_intent_id).catch((e: unknown) => e);
    expect((e1 as Error).message).toBe(`cancel_blocked_by_captures:${inFlight.payment_intent_id}:capture_outcome_unresolved`);

    const unknown = await authorizedIntent(svc, 10_000);
    const c2 = await draftCapture(svc, unknown.payment_intent_id, 1_000);
    await adminPool.query(`UPDATE vipps_captures SET anomaly_flags = '["SUBMIT_OUTCOME_UNKNOWN"]'::jsonb WHERE capture_id = $1`, [c2.capture_id]);
    const e2 = await svc.cancelVippsPayment(TENANT, "business", unknown.payment_intent_id).catch((e: unknown) => e);
    expect((e2 as Error).message).toBe(`cancel_blocked_by_captures:${unknown.payment_intent_id}:capture_outcome_unresolved`);
    expect(vipps.cancelCalls).toHaveLength(0);
  });

  for (const providerState of ["TERMINATED", "EXPIRED", "CANCELLED", "ABORTED"]) {
    it(`webhook ${providerState} etter delvis capture: PROVIDER_STATE_CONFLICT, intensjonen blir `+ "stående `provider_acknowledged`", async () => {
      const vipps = new VippsFake();
      const svc = service(vipps);
      const { intent } = await partiallyCaptured(svc, vipps);
      const result = await webhook(svc, intent.payment_intent_id, providerState);
      expect(result.status).toBe("processed");
      const row = await intentRow(intent.payment_intent_id);
      expect(row.state).toBe("provider_acknowledged");
      expect(row.anomaly_flags).toContain("PROVIDER_STATE_CONFLICT");
      const events = await eventTypes(intent.payment_intent_id);
      expect(events).not.toContain("cancelled");
      const conflicts = await flagEvents(intent.payment_intent_id, "PROVIDER_STATE_CONFLICT");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.metadata).toMatchObject({ reason: `provider_reported_${providerState}`, captures: "settled_captures" });
      expect(JSON.stringify(conflicts[0])).not.toMatch(/2500|10000/); // kun kode, aldri beløp
    });

    it(`oppfrisking som melder ${providerState} etter delvis capture: samme vern (aldri cancelled), og gjentatte oppfriskinger støyer ikke`, async () => {
      const vipps = new VippsFake();
      const svc = service(vipps);
      const { intent } = await partiallyCaptured(svc, vipps);
      vipps.paymentState = { state: providerState };
      const first = await svc.refreshVippsPaymentState(TENANT, "business", intent.payment_intent_id);
      expect(first.state).toBe("provider_acknowledged");
      const second = await svc.refreshVippsPaymentState(TENANT, "business", intent.payment_intent_id);
      expect(second.state).toBe("provider_acknowledged");
      const row = await intentRow(intent.payment_intent_id);
      expect(row.anomaly_flags).toContain("PROVIDER_STATE_CONFLICT");
      expect(await flagEvents(intent.payment_intent_id, "PROVIDER_STATE_CONFLICT")).toHaveLength(1); // kun første gang flagget settes
    });
  }

  it("kontroll: webhook CANCELLED uten captures avslutter intensjonen som før", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    expect((await webhook(svc, intent.payment_intent_id, "CANCELLED")).status).toBe("processed");
    expect((await intentRow(intent.payment_intent_id)).state).toBe("cancelled");
  });

  it("kontroll: CAPTURED-/REFUNDED-hendelser (modifikasjoner) rører ikke vernet", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const { intent } = await partiallyCaptured(svc, vipps);
    expect((await webhook(svc, intent.payment_intent_id, "CAPTURED", { amount: { currency: "NOK", value: 2_500 } })).status).toBe("processed");
    const row = await intentRow(intent.payment_intent_id);
    expect(row.state).toBe("provider_acknowledged");
    expect(row.anomaly_flags).not.toContain("PROVIDER_STATE_CONFLICT");
  });

  it("race: en capture som settes MENS cancel-kallet pågår gjør ikke intensjonen `cancelled` (flagg i stedet)", async () => {
    const vipps = new VippsFake();
    vipps.cancelGate = new Gate();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 2_000);
    const cancel = svc.cancelVippsPayment(TENANT, "business", intent.payment_intent_id);
    const t0 = Date.now();
    while (vipps.cancelCalls.length === 0) {
      if (Date.now() - t0 > 5_000) throw new Error("cancel_call_never_started");
      await new Promise((r) => setTimeout(r, 10));
    }
    await adminPool.query("UPDATE vipps_captures SET state = 'settled', settled_at = now() WHERE capture_id = $1", [capture.capture_id]);
    vipps.cancelGate.open();
    const result = await cancel;
    expect(result.state).toBe("provider_acknowledged");
    const row = await intentRow(intent.payment_intent_id);
    expect(row.state).toBe("provider_acknowledged");
    expect(row.anomaly_flags).toContain("PROVIDER_STATE_CONFLICT");
    expect((await flagEvents(intent.payment_intent_id, "PROVIDER_STATE_CONFLICT"))[0]!.metadata).toMatchObject({ reason: "cancel_executed_while_capture_changed" });
  });

  it("omvendt kappløp: en capture som oppgjøres på en allerede `cancelled` intensjon flagges (aldri stille)", async () => {
    const vipps = new VippsFake();
    const svc = service(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 2_000);
    vipps.gate = new Gate();
    const submit = svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    const t0 = Date.now();
    while (vipps.captureCalls.length === 0) {
      if (Date.now() - t0 > 5_000) throw new Error("capture_call_never_started");
      await new Promise((r) => setTimeout(r, 10));
    }
    // En capture i flukt er «uavklart», så en TERMINATED-hendelse nå ville vært blokkert av K5b-vernet. Den omvendte veien kan derfor kun oppstå fra en eldre/manuelt avsluttet rad:
    // intensjonen settes `cancelled` direkte (som admin) mens capture-kallet pågår.
    await adminPool.query("UPDATE payment_intents SET state = 'cancelled', provider_status = 'CANCELLED', cancelled_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    expect((await intentRow(intent.payment_intent_id)).state).toBe("cancelled");
    vipps.gate.open();
    await submit;
    const row = await intentRow(intent.payment_intent_id);
    expect(row.state).toBe("cancelled"); // terminal tilstand overskrives aldri
    expect(row.anomaly_flags).toContain("PROVIDER_STATE_CONFLICT");
    expect((await flagEvents(intent.payment_intent_id, "PROVIDER_STATE_CONFLICT"))[0]!.metadata).toMatchObject({ reason: "capture_settled_after_intent_ended" });
  });
});
