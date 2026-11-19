import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { assertManifestInvariants, buildToolManifest } from "@jarvis/tool-gateway";
import { SignalLogService } from "../src/signal-log.ts";
import { SituationSignalsTransport, situationSignalsToolDefinitions } from "../src/signals-transport.ts";
import { SituationsTransport, situationsToolDefinitions } from "../src/transport.ts";
import { identity, OTHER, startG4Db, TENANT_A, TENANT_B, type G4Db } from "./support/wpg4-db.ts";

/**
 * WP-G4 (D-466): kontrollflaten for hendelsesabonnementet gjennom den EKTE `ToolGateway`/`PolicyGateway` mot ekte Postgres: identitet kun fra den betrodde konteksten, to uavhengige eier-porter, lukket validering, tenant-isolasjon,
 * og at skjemaet for `set_autonomy_policy` er UENDRET uten hovedbryteren (flagg AV = main).
 */
let db: G4Db;
let gateway: ToolGateway;
const status = { enabled: true, running: false, tick: 7, last: null };

/** Forenklet resultat (`data` er untypet - hver test kaster til sin egen form). */
interface Res {
  ok: boolean;
  reason?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}
async function call(action: string, parameters: Record<string, unknown>, who = identity(TENANT_A, "home")): Promise<Res> {
  return (await gateway.execute({ identity: who, tool_id: "situations", action, parameters: parameters as never, idempotency_key: `k-${action}-${Math.random().toString(36).slice(2)}` })) as unknown as Res;
}

beforeAll(async () => { db = await startG4Db("transport"); }, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(async () => {
  ({ gateway } = db.newGateway());
  const transport = new SituationSignalsTransport({ registry: db.registry, engine: db.engine, logs: new SignalLogService(db.appPool), runner: { status: () => status } });
  for (const tool of situationSignalsToolDefinitions(transport)) gateway.register(tool);
  await db.reset();
});

describe("A: abonnementshandlinger som eier - tenant/space/aktør fra identiteten, aldri fra parametre", () => {
  it("subscribe -> list -> set_subscription_enabled -> remove, i identitetens space; abonnementet er merket med aktørens person og sesjon", async () => {
    const created = await call("subscribe", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } });
    expect(created.ok).toBe(true);
    const row = (created as { ok: true; data: { subscription_id: string; memory_space_id: string; created_by_person_id: string; session_id: string } }).data;
    expect(row).toMatchObject({ memory_space_id: "home", created_by_person_id: "person-g4-owner", session_id: "sess-g4" });
    const listed = await call("list_subscriptions", {});
    expect((listed as { data: unknown[] }).data).toHaveLength(1);
    const off = await call("set_subscription_enabled", { subscription_id: row.subscription_id, enabled: false });
    expect((off as { data: { enabled: boolean } }).data.enabled).toBe(false);
    expect((await db.registry.listEnabled(TENANT_A, "home"))).toHaveLength(0);
    const removed = await call("remove_subscription", { subscription_id: row.subscription_id });
    expect((removed as { data: { removed: boolean } }).data.removed).toBe(true);
    expect(((await call("list_subscriptions", {})) as { data: unknown[] }).data).toHaveLength(0);
  });

  it("identitetsfelt i parametre avvises FØR transporten (`invalid_parameters`): en kaller kan aldri velge tenant, space eller aktør", async () => {
    for (const extra of [{ tenant_id: TENANT_B }, { memory_space_id: "health" }, { person_id: "person-g4-other" }, { actor_person_id: "x" }, { identity: {} }]) {
      const out = await call("subscribe", { source: "incident", event_type: "incident_active", filter: {}, ...extra });
      expect(out.ok, JSON.stringify(extra)).toBe(false);
      expect((out as { reason: string }).reason).toMatch(/invalid_parameters/);
    }
    expect(await db.registry.list(TENANT_A, "home")).toHaveLength(0);
  });

  it("en annen person enn eieren nektes (to uavhengige porter: policy og registerets egen eier-sjekk); lukket validering gir `ok:false`, ingenting lagres", async () => {
    const other = await call("subscribe", { source: "incident", event_type: "incident_active", filter: {} }, identity(TENANT_A, "business", OTHER));
    expect(other.ok).toBe(false);
    const wrongSpace = await call("subscribe", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.a", role: "door" }] } }, identity(TENANT_A, "personal"));
    expect(wrongSpace.ok).toBe(false);
    const wildcard = await call("subscribe", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "*", role: "door" }] } });
    expect(wildcard.ok).toBe(false);
    const othersHealth = await call("subscribe", { source: "health", event_type: "activity_deviation", filter: { person_id: OTHER } }, identity(TENANT_A, "health"));
    expect(othersHealth.ok).toBe(false);
    expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM situation_subscriptions`)).rows[0].n).toBe(0);
  });

  it("tenant-isolasjon: tenant B ser og rører aldri A sine abonnementer gjennom verktøyet", async () => {
    const created = await call("subscribe", { source: "incident", event_type: "incident_active", filter: {} }, identity(TENANT_A, "business"));
    const id = (created as { data: { subscription_id: string } }).data.subscription_id;
    expect(((await call("list_subscriptions", {}, identity(TENANT_B, "business"))) as { data: unknown[] }).data).toHaveLength(0);
    expect((await call("remove_subscription", { subscription_id: id }, identity(TENANT_B, "business"))).ok).toBe(true); // B sin egen (tomme) radmengde: ingenting å fjerne
    expect(((await call("list_subscriptions", {}, identity(TENANT_A, "business"))) as { data: unknown[] }).data).toHaveLength(1);
  });
});

describe("B: signallogg, status og stille timer", () => {
  it("get_signal_status gir løperens siste status (kun tellinger), og `enabled:false` uten løper; list_signals avviser ukjent kilde", async () => {
    expect(((await call("get_signal_status", {})) as { data: { enabled: boolean; tick: number } }).data).toMatchObject({ enabled: true, tick: 7 });
    const bare = new SituationSignalsTransport({ registry: db.registry, engine: db.engine, logs: new SignalLogService(db.appPool) });
    expect(await bare.invoke("get_signal_status", {}, "x", { identity: identity(TENANT_A, "home") } as never)).toEqual({ data: { enabled: false } });
    expect((await call("list_signals", { source: "kafka" })).ok).toBe(false);
    expect(((await call("list_signals", { limit: 5 })) as { data: unknown[] }).data).toEqual([]);
  });

  it("set_critical_quiet_bypass: kun eieren, bevarer stille timer, og er reversibelt", async () => {
    await db.engine.setNotificationPolicy(TENANT_A, "home", { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6 });
    const on = await call("set_critical_quiet_bypass", { enabled: true });
    expect((on as { data: { critical_bypass_quiet: boolean; quiet_hours_start_utc: number } }).data).toMatchObject({ critical_bypass_quiet: true, quiet_hours_start_utc: 22 });
    expect(((await call("set_critical_quiet_bypass", { enabled: false })) as { data: { critical_bypass_quiet: boolean } }).data.critical_bypass_quiet).toBe(false);
    expect((await call("set_critical_quiet_bypass", { enabled: true }, identity(TENANT_A, "home", OTHER))).ok).toBe(false);
  });
});

describe("C: flagg AV = identisk med main - skjemaet for set_autonomy_policy og verktøylisten", () => {
  const transport = new SituationsTransport({} as never, {} as never);

  it("uten `autonomyExpiry` har set_autonomy_policy INGEN expires_at (en parameter avvises); med flagget aksepteres den", () => {
    const base = situationsToolDefinitions(transport).find((t) => t.action === "set_autonomy_policy")!;
    const withExpiry = situationsToolDefinitions(transport, { autonomyExpiry: true }).find((t) => t.action === "set_autonomy_policy")!;
    const params = { domain: "home", tool_id: "t", action: "a", expires_at: "2027-01-01T00:00:00Z" };
    expect(base.input_schema.safeParse(params).success).toBe(false);
    expect(withExpiry.input_schema.safeParse(params).success).toBe(true);
    // ellers identiske lister
    expect(situationsToolDefinitions(transport).map((t) => `${t.tool_id}.${t.action}`)).toEqual(situationsToolDefinitions(transport, { autonomyExpiry: true }).map((t) => `${t.tool_id}.${t.action}`));
  });

  it("de nye handlingene er eier-eksklusive (ingen modellflate), klasse A/B/C, og manifest-invariantene består (også med tilbakemeldingshandlingene: navnene må ikke utledes som pay/control)", () => {
    const signalDefs = situationSignalsToolDefinitions(new SituationSignalsTransport({} as never), { feedback: true });
    const defs = [...situationsToolDefinitions(transport), ...signalDefs];
    const manifest = buildToolManifest(defs);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    for (const def of signalDefs) {
      const entry = manifest.get(`situations.${def.action}`)!;
      expect(entry.surfaces, def.action).toEqual([]);
      expect(["A", "B", "C"]).toContain(def.capability_class);
      expect(def.tool_id).toBe("situations");
      // ingen av de nye handlingene utledes som betaling (`submit_*`), og ingen er klasse D
      expect(entry.effect, def.action).not.toBe("pay");
      expect(def.capability_class, def.action).not.toBe("D");
    }
    const names = situationSignalsToolDefinitions(new SituationSignalsTransport({} as never)).map((d) => d.action).sort();
    expect(names).toEqual(["get_signal_status", "get_situation_simulation", "list_assessments", "list_signals", "list_subscriptions", "remove_subscription", "set_critical_quiet_bypass", "set_subscription_enabled", "subscribe"]);
    // tilbakemeldingshandlingene finnes KUN med `feedback: true` (JARVIS_SITUATION_FEEDBACK)
    const withFeedback = situationSignalsToolDefinitions(new SituationSignalsTransport({} as never), { feedback: true }).map((d) => d.action).sort();
    expect(withFeedback).toEqual([...names, "get_rule_tuning", "record_feedback", "reset_rule_tuning"].sort());
    // ingen kollisjon med eksisterende handlinger
    const existing = new Set(situationsToolDefinitions(transport).map((d) => d.action));
    for (const n of names) expect(existing.has(n), n).toBe(false);
  });
});
