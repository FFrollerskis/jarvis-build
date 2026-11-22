import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  CAR_CRITICAL_OPS, CAR_READ_ACTION, CarAdapterError, CarTransport, PersonalActionJournal, UnconfiguredCarAdapter, carCriticalToolDefinitions, executePersonalAction, parseCarTargets, personalActionIndex,
  type CarAdapter, type SecretProvider
} from "../src/index.ts";
import { FakeCarAdapter } from "./support/fake-car-adapter.ts";
import { G2_OTHER_TENANT, G2_TENANT, g2Owner as owner, personalGateway, startPersonalDb, type PersonalDb, type PersonalGatewayHarness } from "./support/personal-db-harness.ts";

/**
 * WP-G2 P1b (D-464): bil-handlingene gjennom den EKTE `ToolGateway`-pipelinen (embedded Postgres, ekte policy, ekte klasse D-kjede) med en FALSK `CarAdapter` + handlingsjournalen (domene `car`).
 * Bevist: ingen leverandør = ingen kommando (credential finnes ikke / adapter ikke konfigurert), step-up (strengeste standard), mål-allowlist, hele kjeden, feil sluttilstand (ineffektiv/bufret) vises umiddelbart,
 * ukjent utfall gir aldri ny kommando, entydig avvisning er retry-bar, journal med domene `car`, isolasjon mellom domene og tenant.
 */
let db: PersonalDb;
const fake = new FakeCarAdapter();
beforeAll(async () => { db = await startPersonalDb("jarvis_test_g2_car"); }, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(() => { fake.reset(); });

interface Harness extends PersonalGatewayHarness { journal: PersonalActionJournal; executor: Parameters<typeof executePersonalAction>[0] }

function harness(opts: { adapter?: CarAdapter; credential?: boolean; targets?: string } = {}): Harness {
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "JARVIS_PERSONAL_CAR_CREDENTIAL" && opts.credential !== false ? "fake-car-credential-for-test" : null) };
  const base = personalGateway(db.appPool, secrets);
  let t = 0;
  const transport = new CarTransport({ adapter: opts.adapter ?? fake, settleMs: 10_000, pollMs: 1_000, now: () => t, sleep: async (ms) => { t += ms; } });
  for (const d of carCriticalToolDefinitions(transport, { targets: parseCarTargets(opts.targets ?? "bil,elbil"), settleMs: 10_000, pollMs: 1_000 })) base.gateway.register(d);
  const journal = new PersonalActionJournal(db.appPool);
  const index = personalActionIndex(CAR_CRITICAL_OPS.map((op) => ({ domain: "car" as const, toolId: "car", op })));
  return { ...base, journal, executor: { pool: db.appPool, gateway: base.gateway, journal, index } };
}

let seq = 0;
const key = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;
const run = (h: Harness, action: string, params: Record<string, JsonValue>, k?: string, identity: IdentityContext = owner) =>
  h.gateway.execute({ identity, tool_id: "car", action, parameters: params, ...(k ? { idempotency_key: k } : {}) });
async function ledger(k: string) {
  return (await db.adminPool.query("SELECT status, before_state, after_state, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as
    { status: string; before_state: Record<string, unknown> | null; after_state: Record<string, unknown> | null; postcondition_reason: string | null } | undefined;
}

describe("A: ingen leverandør = ingen handling (D-64: INGEN er valgt; live er BLOCKED_EXTERNAL)", () => {
  it("uten credential i vaulten: `credential_unavailable` - verken lesing eller kommando når adapteren", async () => {
    const h = harness({ credential: false });
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    expect(await run(h, "unlock", { vehicle_id: "bil" }, key("nc"))).toEqual({ ok: false, reason: "credential_unavailable" });
    expect(await run(h, CAR_READ_ACTION, { vehicle_id: "bil" })).toEqual({ ok: false, reason: "credential_unavailable" });
    expect(fake.calls).toHaveLength(0);
  });

  it("med credential, men uten adapter (UnconfiguredCarAdapter): preflight feiler lukket med `car_provider_not_configured`, ingenting sendes, ingen varsel", async () => {
    const h = harness({ adapter: new UnconfiguredCarAdapter() });
    expect(await run(h, "unlock", { vehicle_id: "bil" }, key("uc"))).toEqual({ ok: false, reason: "preflight_failed:car_provider_not_configured" });
    expect(await run(h, CAR_READ_ACTION, { vehicle_id: "bil" })).toMatchObject({ ok: false });
    expect(h.notifications).toHaveLength(0);
  });
});

describe("B: hele klasse D-kjeden for bil", () => {
  it("lås opp (D): ok, ledger `succeeded` med fersk før-/etter-tilstand, nøyaktig ett kommandokall og et umiddelbart varsel med redigert sammendrag", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped", applyAfterReads: 2 });
    const k = key("unlock");
    expect(await run(h, "unlock", { vehicle_id: "bil" }, k)).toMatchObject({ ok: true, notified: true, external_id: "fake-cmd-unlock" });
    expect(fake.commandCalls()).toHaveLength(1);
    const row = await ledger(k);
    expect(row?.status).toBe("succeeded");
    expect(row?.before_state).toMatchObject({ lock: "locked", fresh: true });
    expect(row?.after_state).toMatchObject({ lock: "unlocked", fresh: true });
    expect(h.notifications.at(-1)).toMatchObject({ outcome: "executed", tool_id: "car", action: "unlock", idempotency_key: k });
    expect(h.notifications.at(-1)?.summary).toBe("bil bil: lås locked -> unlocked (ønsket)");
  });

  it("lås, klima og lading fullfører kjeden; samme nøkkel gir lagret resultat uten ny kommando", async () => {
    const h = harness();
    fake.set("bil", { lock: "unlocked", climate: "off", charging: "stopped" });
    const cases: Array<[string, Record<string, JsonValue>]> = [["lock", { vehicle_id: "bil" }], ["climate_set", { vehicle_id: "bil", on: true }], ["charge_set", { vehicle_id: "bil", charging: true }]];
    for (const [action, params] of cases) expect(await run(h, action, params, key(action)), action).toMatchObject({ ok: true, notified: true });
    expect(fake.commandCalls().map((c) => c.command?.kind)).toEqual(["lock", "climate_start", "charge_start"]);
    const k = key("dup");
    await run(h, "unlock", { vehicle_id: "bil" }, k);
    const again = await run(h, "unlock", { vehicle_id: "bil" }, k);
    expect(again).toMatchObject({ ok: true, deduplicated: true });
    expect(fake.commandCalls()).toHaveLength(4);
  });

  it("step-up: svak økt, tale, Telegram, system/autonomi og klokke avvises FØR adapteren nås (strengeste standard); delegat og fremmed tenant avvises", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    const cases: Array<[string, IdentityContext, string]> = [
      ["active", { ...owner, auth_strength: "active" }, "step_up_required:signed_device_session"],
      ["voice signed", { ...owner, channel: "voice" }, "step_up_required:channel_voice_not_allowed"],
      ["telegram signed", { ...owner, channel: "telegram" }, "step_up_required:channel_telegram_not_allowed"],
      ["system active (autonomi-binding)", { ...owner, channel: "system", auth_strength: "active" }, "step_up_required:signed_device_session"],
      ["system signed", { ...owner, channel: "system" }, "step_up_required:channel_system_not_allowed"]
    ];
    for (const [name, identity, reason] of cases) expect(await run(h, "unlock", { vehicle_id: "bil" }, key("su"), identity), name).toEqual({ ok: false, reason });
    for (const identity of [{ ...owner, person_id: "person-g2-p-delegate", session_id: "sd" }, { ...owner, tenant_id: G2_OTHER_TENANT, person_id: "person-g2-p-other" }]) {
      const result = await run(h, "unlock", { vehicle_id: "bil" }, key("dg"), identity);
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toMatch(/^(credential_not_bound_to_identity|owner_only|class_d_missing_approval)/);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("mål-allowlist før adapteren, ukjent bil (`preflight_target_not_found`), ugyldig før-tilstand, manglende nøkkel og varsler som ikke er klar", async () => {
    const h = harness({ targets: "bil" });
    fake.set("annen", { lock: "locked", climate: "off", charging: "stopped" });
    fake.set("bil", { lock: "locked", climate: "off", charging: "disconnected" });
    expect(await run(h, "unlock", { vehicle_id: "annen" }, key("t"))).toEqual({ ok: false, reason: "car_target_not_authorized" });
    expect(await run(harness({ targets: "" }), "unlock", { vehicle_id: "bil" }, key("t2"))).toEqual({ ok: false, reason: "car_target_not_authorized" });
    expect(await run(h, "lock", { vehicle_id: "bil" })).toEqual({ ok: false, reason: "class_d_idempotency_key_required" });
    expect(await run(h, "charge_set", { vehicle_id: "bil", charging: true }, key("pl"))).toEqual({ ok: false, reason: "preflight_invalid:vehicle_not_plugged_in" });
    h.setNotifierReady(false);
    expect(await run(h, "lock", { vehicle_id: "bil" }, key("nr"))).toEqual({ ok: false, reason: "class_d_notifier_not_ready" });
    h.setNotifierReady(true);
    expect(await run(harness({ targets: "bil,ukjent" }), "lock", { vehicle_id: "ukjent" }, key("uk"))).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(fake.commandCalls()).toHaveLength(0);
  });

  it("kill switch og frys (tool_id `car`) stanser handlingen", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    h.killSwitch.activate("test");
    expect((await run(h, "unlock", { vehicle_id: "bil" }, key("ks"))).ok).toBe(false);
    h.killSwitch.deactivate();
    h.controls.freezeConnector("car");
    expect(await run(h, "unlock", { vehicle_id: "bil" }, key("fz"))).toEqual({ ok: false, reason: "connector_frozen" });
    h.controls.unfreezeConnector("car");
    expect(fake.commandCalls()).toHaveLength(0);
  });
});

describe("C: feil sluttilstand og uavklart utfall vises UMIDDELBART", () => {
  it("uvirksom kommando: `postcondition_mismatch`, ledger `unverified`, varsel «utført men ikke verifisert», etter-bildet viser den gamle tilstanden", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped", mode: "ineffective" });
    const k = key("ineff");
    expect(await run(h, "unlock", { vehicle_id: "bil" }, k)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect((await ledger(k))?.after_state).toMatchObject({ lock: "locked" });
    expect((await ledger(k))?.status).toBe("unverified");
    expect(h.notifications.at(-1)?.outcome).toBe("unverified");
  });

  it("bufret tilstand etter kommandoen (viser ønsket verdi, men `fresh: false`): ALDRI verifisert", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped", mode: "stale_after_command" });
    const k = key("stale");
    expect(await run(h, "unlock", { vehicle_id: "bil" }, k)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect((await ledger(k))?.after_state).toMatchObject({ lock: "unlocked", fresh: false });
  });

  it("leverandøren svarer med ukjent utfall: `unverified`, varsel «ukjent», og en replay med samme nøkkel sender ALDRI en ny kommando", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    const k = key("unk");
    fake.nextCommandError = new CarAdapterError("car_unavailable", false);
    expect(await run(h, "unlock", { vehicle_id: "bil" }, k)).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:car_unavailable" });
    expect((await ledger(k))?.status).toBe("unverified");
    expect(h.notifications.at(-1)?.outcome).toBe("unknown");
    const commands = fake.commandCalls().length;
    expect((await run(h, "unlock", { vehicle_id: "bil" }, k)).ok).toBe(false);
    expect(fake.commandCalls()).toHaveLength(commands);
  });

  it("entydig avvist (rate-limit/avvist før sending): `failed` og retry med samme nøkkel er TILLATT", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    const k = key("rl");
    fake.nextCommandError = new CarAdapterError("car_rate_limited", true);
    expect(await run(h, "unlock", { vehicle_id: "bil" }, k)).toEqual({ ok: false, reason: "tool_failed:car_rate_limited" });
    expect((await ledger(k))?.status).toBe("failed");
    expect((await run(h, "unlock", { vehicle_id: "bil" }, k)).ok).toBe(true);
  });
});

describe("D: handlingsjournalen for domene `car`", () => {
  const exec = (h: Harness, action: string, parameters: Record<string, JsonValue>, k: string, identity: IdentityContext = owner) =>
    executePersonalAction(h.executor, identity, { domain: "car", action, parameters, idempotency_key: k });

  it("SUCCESS: raden er `applied`, domene `car`, målet er aliaset (aldri VIN), risikoretning `increases`, med før-/etter-tilstand og proveniens", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    const result = await exec(h, "unlock", { vehicle_id: "bil" }, key("j-car"));
    expect(result).toMatchObject({ outcome: "SUCCESS", replayed: false });
    expect(result.action).toMatchObject({
      status: "applied", domain: "car", tool_id: "car", action: "unlock", risk_class: "D", risk_direction: "increases", target_ref: "bil", actor_person_id: owner.person_id, tenant_id: G2_TENANT,
      memory_space_id: "personal", source: "owner_route", session_id: owner.session_id
    });
    expect(result.action.before_state).toMatchObject({ lock: "locked" });
    expect(result.action.after_state).toMatchObject({ lock: "unlocked" });
  });

  it("MISMATCH og UNKNOWN gir `outcome_unknown` (aldri applied); replay etterpå gir ingen ny kommando; en avvisning på replay nedgraderer aldri raden", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped", mode: "ineffective" });
    const mismatch = await exec(h, "unlock", { vehicle_id: "bil" }, key("j-mm"));
    expect(mismatch).toMatchObject({ outcome: "MISMATCH", reason: "postcondition_mismatch" });
    expect(mismatch.action.status).toBe("outcome_unknown");

    fake.set("elbil", { lock: "locked", climate: "off", charging: "stopped" });
    const k = key("j-unk");
    fake.nextCommandError = new CarAdapterError("car_unavailable", false);
    expect((await exec(h, "unlock", { vehicle_id: "elbil" }, k)).outcome).toBe("UNKNOWN");
    const commands = fake.commandCalls().length;
    const weak = await exec(h, "unlock", { vehicle_id: "elbil" }, k, { ...owner, auth_strength: "active" });
    expect(weak).toMatchObject({ outcome: "UNKNOWN", replayed: true });
    expect(weak.action.status).toBe("outcome_unknown");
    expect(fake.commandCalls()).toHaveLength(commands);
  });

  it("domener er adskilt: en bil-handling kan ikke utføres som `home`, og en hjem-handling ikke som `car`; konflikt ved samme nøkkel for annen forespørsel", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    await expect(executePersonalAction(h.executor, owner, { domain: "home", action: "unlock", parameters: { vehicle_id: "bil" }, idempotency_key: key("x") })).rejects.toThrow("personal_action_unknown_action");
    await expect(exec(h, "critical_lock", { entity: "lock.a", locked: true }, key("x"))).rejects.toThrow("personal_action_unknown_action");
    const k = key("conf");
    await exec(h, "unlock", { vehicle_id: "bil" }, k);
    await expect(exec(h, "lock", { vehicle_id: "bil" }, k)).rejects.toThrow("personal_action_idempotency_conflict");
  });

  it("RLS: journalen for `car` er skjult for en annen tenant og et annet rom; listing filtrerer på domene", async () => {
    const h = harness();
    fake.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    const k = key("rls-car");
    await exec(h, "unlock", { vehicle_id: "bil" }, k);
    expect(await h.journal.findByKey(G2_TENANT, "personal", k)).not.toBeNull();
    expect(await h.journal.findByKey(G2_TENANT, "home", k)).toBeNull();
    expect(await h.journal.findByKey(G2_OTHER_TENANT, "personal", k)).toBeNull();
    const rows = await h.journal.list(G2_TENANT, "personal", { domain: "car", limit: 200 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.domain === "car")).toBe(true);
    expect((await h.journal.list(G2_TENANT, "personal", { domain: "home" })).length).toBe(0);
  });
});
