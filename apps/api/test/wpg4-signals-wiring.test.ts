import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { ToolGateway } from "@jarvis/tool-gateway";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  aggregateDaily, createHealthReader, createHomeReader, createIncidentReader, createSituationSignalsWiring, createVisionReader, type SituationSignalsWiringDeps
} from "../src/situation-signals-wiring.ts";

/**
 * WP-G4 (D-466): koblingen i api-prosessen. Flagg AV = ingenting bygges (identisk med main); hver kildeport gir KUN minimerte observasjoner; rå helseverdier aggregeres og forlater aldri prosessen; filen importerer ikke helsepakken.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OWNER = "person-owner";
const ownerIdentity: IdentityContext = { person_id: OWNER, tenant_id: "t-owner", memory_space_id: "personal", session_id: "sess-api", device_id: "jarvis-core", channel: "api", auth_strength: "active" };
const identityFor = (tenantId: string, space: MemorySpace): IdentityContext => ({ ...ownerIdentity, tenant_id: tenantId, memory_space_id: space });
const NOW = Date.parse("2026-11-19T12:00:00.000Z");

function deps(env: Record<string, string>, over: Partial<SituationSignalsWiringDeps> = {}): SituationSignalsWiringDeps {
  return {
    env, pool: {} as never, engine: {} as never, domainPauses: {} as never, gateway: {} as never, modelGateway: { complete: async () => { throw new Error("aldri kalt"); } },
    ownerIdentity, ownerTenant: "t-owner", ownerPersonId: OWNER, incidents: { listIncidents: async () => [] }, vision: { getRecentEvents: async () => [] }, health: { getRecentMetrics: async () => [] },
    haTransport: { invoke: async () => ({}) }, killSwitch: { isActiveDurable: async () => false }, now: () => NOW, ...over
  };
}

describe("A: flagg AV = ingenting bygges", () => {
  it("uten hovedbryter (også med alle underflagg): ingen verktøy, ingen løper, ingen register, ingen loggline", () => {
    for (const env of [{}, { JARVIS_SITUATION_HOME: "on", JARVIS_SITUATION_VISION: "on", JARVIS_SITUATION_HEALTH: "on", JARVIS_SITUATION_INCIDENTS: "on", JARVIS_SITUATION_MODEL_ASSIST: "on" }, { JARVIS_SITUATION_SIGNALS: "true" }, { JARVIS_SITUATION_SIGNALS: "1" }]) {
      const w = createSituationSignalsWiring(deps(env));
      expect(w.tools).toEqual([]);
      expect(w.runner).toBeNull();
      expect(w.registry).toBeNull();
      expect(w.describe()).toBeNull();
      expect(() => w.start()).not.toThrow();
    }
  });

  it("hovedbryter alene: kun kontroll- og lesehandlingene (9 nye verktøy + `set_autonomy_policy` med `expires_at`, INGEN tilbakemelding) og en løper uten leser; INGEN HA-lesehandling og ingen kildelesing; startloggen sier hva som er på", () => {
    const w = createSituationSignalsWiring(deps({ JARVIS_SITUATION_SIGNALS: "on" }));
    expect(w.tools.map((t) => `${t.tool_id}.${t.action}`).sort()).toEqual([
      "situations.get_signal_status", "situations.get_situation_simulation", "situations.list_assessments", "situations.list_signals", "situations.list_subscriptions", "situations.remove_subscription",
      "situations.set_autonomy_policy", "situations.set_critical_quiet_bypass", "situations.set_subscription_enabled", "situations.subscribe"
    ]);
    expect(w.runner).not.toBeNull();
    expect(w.describe()).toMatchObject({ msg: "situation_signals", interval_seconds: 60, log_retention_days: 30, spaces: [], sources: { home: false, vision: false, health: false, incidents: false }, model_assist: false });
  });

  it("tilbakemeldingshandlingene (record_feedback, get_rule_tuning, reset_rule_tuning) registreres KUN med JARVIS_SITUATION_FEEDBACK under hovedbryteren", () => {
    const w = createSituationSignalsWiring(deps({ JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_FEEDBACK: "on" }));
    const actions = w.tools.map((t) => t.action);
    for (const a of ["record_feedback", "get_rule_tuning", "reset_rule_tuning"]) expect(actions).toContain(a);
    expect(w.tools).toHaveLength(13);
    expect(createSituationSignalsWiring(deps({ JARVIS_SITUATION_FEEDBACK: "on" })).tools).toEqual([]);
  });

  it("set_autonomy_policy: med hovedbryteren ERSTATTER en definisjon med samme navn (siste registrering vinner) den eksisterende og gir et valgfritt `expires_at`; uten den er skjemaet identisk med main og ingen override finnes", () => {
    const gw = new ToolGateway({} as never, {} as never, { name: "t", get: async () => null });
    for (const d of situationsToolDefinitions(new SituationsTransport({} as never, {} as never))) gw.register(d); // slik main.ts registrerer dem (uendret linje)
    const params = { domain: "home", tool_id: "test_actuator", action: "close", expires_at: "2027-01-01T00:00:00Z" };
    expect(gw.get("situations", "set_autonomy_policy")!.input_schema.safeParse(params).success).toBe(false);
    expect(gw.get("situations", "set_autonomy_policy")!.input_schema.safeParse({ domain: "home", tool_id: "test_actuator", action: "close" }).success).toBe(true);
    const off = createSituationSignalsWiring(deps({}));
    for (const d of off.tools) gw.register(d);
    expect(gw.get("situations", "set_autonomy_policy")!.input_schema.safeParse(params).success).toBe(false); // flagg AV: uendret
    const on = createSituationSignalsWiring(deps({ JARVIS_SITUATION_SIGNALS: "on" }));
    for (const d of on.tools) gw.register(d);
    const merged = gw.get("situations", "set_autonomy_policy")!;
    expect(merged.input_schema.safeParse(params).success).toBe(true);
    expect(merged.input_schema.safeParse({ domain: "home", tool_id: "test_actuator", action: "close" }).success).toBe(true);
    // samme klasse og scopes som den opprinnelige (kun skjemaet er utvidet)
    const original = situationsToolDefinitions(new SituationsTransport({} as never, {} as never)).find((d) => d.action === "set_autonomy_policy")!;
    expect([merged.capability_class, merged.scopes, merged.reversible, merged.rollback_procedure]).toEqual([original.capability_class, original.scopes, original.reversible, original.rollback_procedure]);
    // listen til main.ts har nøyaktig ÉN definisjon per handling etter registrering
    expect(gw.list().filter((d) => d.tool_id === "situations" && d.action === "set_autonomy_policy")).toHaveLength(1);
  });

  it("HA-lesehandlingen registreres KUN med JARVIS_SITUATION_HOME; rommene følger kildene; ugyldig tallkonfigurasjon gir standard", () => {
    const home = createSituationSignalsWiring(deps({ JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_HOME: "on", JARVIS_SITUATION_BUS_INTERVAL_SECONDS: "5", JARVIS_SITUATION_LOG_RETENTION_DAYS: "abc" }));
    expect(home.tools.map((t) => `${t.tool_id}.${t.action}`)).toContain("home-assistant.read_state_detail");
    expect(home.describe()).toMatchObject({ interval_seconds: 60, log_retention_days: 30, spaces: ["home"], sources: { home: true } });
    const all = createSituationSignalsWiring(deps({
      JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_VISION: "on", JARVIS_SITUATION_HEALTH: "on", JARVIS_SITUATION_INCIDENTS: "on", JARVIS_SITUATION_BUS_INTERVAL_SECONDS: "120", JARVIS_SITUATION_LOG_RETENTION_DAYS: "90"
    }));
    expect(all.describe()).toMatchObject({ interval_seconds: 120, log_retention_days: 90, sources: { home: false, vision: true, health: true, incidents: true } });
    expect((all.describe() as { spaces: string[] }).spaces.sort()).toEqual(["business", "health", "home"]);
    expect(all.tools.map((t) => t.action)).not.toContain("read_state_detail");
  });
});

describe("B: hjem-leseren - kun abonnerte entiteter via ToolGateway, effekt-teller i minnet, synlig kildefeil", () => {
  const calls: Array<{ identity: IdentityContext; tool_id: string; action: string; parameters: Record<string, unknown> }> = [];
  const gatewayWith = (handler: (entity: string) => unknown): Pick<ToolGateway, "execute"> => ({
    execute: async (req: never) => {
      const r = req as { identity: IdentityContext; tool_id: string; action: string; parameters: { entity: string } };
      calls.push({ identity: r.identity, tool_id: r.tool_id, action: r.action, parameters: r.parameters });
      return handler(r.parameters.entity) as never;
    }
  });
  const ctx = (now = NOW) => ({ tenant_id: "t-owner", memory_space: "home" as MemorySpace, now });

  it("ett kall per entitet med riktig verktøy/handling og eierens identitet i kildens rom; kun {entity} sendes", async () => {
    calls.length = 0;
    const read = createHomeReader({
      gateway: gatewayWith((entity) => ({ ok: true, data: { entity_id: entity, state: "on", last_changed: "2026-11-19T11:00:00.000Z", device_class: "door" }, output_trust: "untrusted", deduplicated: false })), identityFor
    });
    const out = await read(ctx(), [{ entity_id: "binary_sensor.inngang", role: "door" }, { entity_id: "binary_sensor.kjeller", role: "leak" }]);
    expect(calls.map((c) => [c.tool_id, c.action, c.parameters])).toEqual([["home-assistant", "read_state_detail", { entity: "binary_sensor.inngang" }], ["home-assistant", "read_state_detail", { entity: "binary_sensor.kjeller" }]]);
    expect(calls[0]!.identity).toMatchObject({ person_id: OWNER, tenant_id: "t-owner", memory_space_id: "home" });
    expect(out).toEqual([
      { source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: "2026-11-19T11:00:00.000Z" },
      { source: "home_assistant", entity_id: "binary_sensor.kjeller", role: "leak", state: "on", last_changed: "2026-11-19T11:00:00.000Z" }
    ]);
  });

  it("ukjent entitet (data:null) og misformet svar hoppes over uten feil; delvis feil er ikke en kildefeil; ALLE feil er det (`home_source_unavailable`)", async () => {
    const partial = createHomeReader({
      gateway: gatewayWith((e) => (e === "binary_sensor.a" ? { ok: true, data: null, output_trust: "untrusted", deduplicated: false } : e === "binary_sensor.b" ? { ok: false, reason: "x" } : { ok: true, data: { state: 5, last_changed: null }, output_trust: "untrusted", deduplicated: false })), identityFor
    });
    expect(await partial(ctx(), [{ entity_id: "binary_sensor.a", role: "door" }, { entity_id: "binary_sensor.c", role: "door" }])).toEqual([]);
    const mixed = createHomeReader({
      gateway: gatewayWith((e) => (e === "binary_sensor.b" ? { ok: false, reason: "x" } : { ok: true, data: { state: "off", last_changed: "2026-11-19T11:00:00.000Z" }, output_trust: "untrusted", deduplicated: false })), identityFor
    });
    expect(await mixed(ctx(), [{ entity_id: "binary_sensor.a", role: "door" }, { entity_id: "binary_sensor.b", role: "door" }])).toHaveLength(1);
    const allFail = createHomeReader({ gateway: gatewayWith(() => ({ ok: false, reason: "credential_unavailable" })), identityFor });
    await expect(allFail(ctx(), [{ entity_id: "binary_sensor.a", role: "door" }])).rejects.toThrow("home_source_unavailable");
  });

  it("effekt: telleren øker bare mens verdien ligger OVER eierens grense, beholder startpunktet, og nullstilles når den faller under", async () => {
    let watts = "2500";
    const read = createHomeReader({ gateway: gatewayWith(() => ({ ok: true, data: { state: watts, last_changed: "2026-11-19T11:59:00.000Z" }, output_trust: "untrusted", deduplicated: false })), identityFor });
    const entities = [{ entity_id: "sensor.ovn", role: "power" as const, limit_w: 2000 }];
    const t1 = await read(ctx(NOW), entities);
    const t2 = await read(ctx(NOW + 60_000), entities);
    expect(t1[0]).toMatchObject({ over_limit_ticks: 1, over_limit_since: new Date(NOW).toISOString(), limit_w: 2000 });
    expect(t2[0]).toMatchObject({ over_limit_ticks: 2, over_limit_since: new Date(NOW).toISOString() });
    watts = "800";
    // fiks-runde (A-MEDIUM-4): under grensen leveres som en NORMAL observasjon (`over_limit_ticks: 0`), så bussen kan løse en åpen effektsituasjon; broen gir fortsatt ingen signal for den
    expect(await read(ctx(NOW + 120_000), entities)).toEqual([
      { source: "home_assistant", entity_id: "sensor.ovn", role: "power", state: "800", last_changed: "2026-11-19T11:59:00.000Z", limit_w: 2000, over_limit_ticks: 0, over_limit_since: new Date(NOW + 120_000).toISOString() }
    ]);
    watts = "2600";
    expect((await read(ctx(NOW + 180_000), entities))[0]).toMatchObject({ over_limit_ticks: 1, over_limit_since: new Date(NOW + 180_000).toISOString() });
    watts = "ikke-et-tall";
    // en ukjent verdi er IKKE normal (ingen `over_limit_ticks`): ingen løsing på gjetning, og telleren er nullstilt
    expect(await read(ctx(NOW + 240_000), entities)).toEqual([{ source: "home_assistant", entity_id: "sensor.ovn", role: "power", state: "ikke-et-tall", last_changed: "2026-11-19T11:59:00.000Z" }]);
  });
});

describe("C: kamera-, helse- og hendelsesleserne leverer minimerte observasjoner", () => {
  const ctx = { tenant_id: "t-owner", memory_space: "home" as MemorySpace, now: NOW };

  it("kamera: Date -> ISO, bare de seks feltene, kun eierens person, og oppslagsvinduet sendes videre", async () => {
    const seen: unknown[] = [];
    const read = createVisionReader({
      ownerPersonId: OWNER,
      vision: { getRecentEvents: async (t, s, p, f) => { seen.push([t, s, p, f]); return [{
        observation_id: "o1", event_type: "doorbell_event", source_instance_id: "camera.inngang", source_event_id: "e@x", observed_at: new Date("2026-11-19T11:59:00Z"), object_label: null, classification_status: "classified",
        // felt som IKKE skal videre (kilden kan ha flere): leseren plukker kun de seks
        ...({ snapshot_ref: "snap-secret", person_id: "p", payload_fingerprint: "f", confidence: 0.9 } as object)
      }, { observation_id: "o2", event_type: "motion_detected", source_instance_id: "c", source_event_id: "e", observed_at: "ugyldig", object_label: null, classification_status: "x" }]; } }
    });
    const out = await read(ctx, NOW - 600_000);
    expect(seen).toEqual([["t-owner", "home", OWNER, { sinceMs: NOW - 600_000 }]]);
    expect(out).toEqual([{ source: "vision", observation_id: "o1", event_type: "doorbell_event", source_instance_id: "camera.inngang", source_event_id: "e@x", observed_at: "2026-11-19T11:59:00.000Z", object_label: null, classification_status: "classified" }]);
    expect(JSON.stringify(out)).not.toMatch(/snap-secret|payload_fingerprint|confidence/);
  });

  it("helse: aggregerer rå prøver til ett tall per UTC-døgn (snitt for hvilepuls, sum for skritt/søvn); kun eierens person; ingen logging", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queried: unknown[] = [];
    const read = createHealthReader({
      ownerPersonId: OWNER,
      health: { getRecentMetrics: async (t, p, m, since) => { queried.push([t, p, m, since]); return [
        { value: 60, observed_at: "2026-11-17T08:00:00Z" }, { value: 64, observed_at: "2026-11-17T20:00:00Z" }, { value: 70, observed_at: new Date("2026-11-18T09:00:00Z") }, { value: Number.NaN, observed_at: "2026-11-18T10:00:00Z" }
      ]; } }
    });
    const out = await read({ ...ctx, memory_space: "health" }, OWNER, ["resting_heart_rate"]);
    expect(queried).toEqual([["t-owner", OWNER, "resting_heart_rate", NOW - 35 * 86_400_000]]);
    expect(out).toEqual([{ source: "health", metric: "resting_heart_rate", series: [{ day: "2026-11-17", value: 62, samples: 2 }, { day: "2026-11-18", value: 70, samples: 1 }] }]);
    expect(await read({ ...ctx, memory_space: "health" }, "person-annen", ["steps"])).toEqual([]); // aldri andres helse
    expect(queried).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });

  it("aggregateDaily: snitt vs sum, sortert, ugyldige verdier/tider ignorert", () => {
    expect(aggregateDaily("steps", [{ value: 1000, observed_at: "2026-11-18T10:00:00Z" }, { value: 2500, observed_at: "2026-11-18T18:00:00Z" }, { value: 4000, observed_at: "2026-11-17T12:00:00Z" }])).toEqual([
      { day: "2026-11-17", value: 4000, samples: 1 }, { day: "2026-11-18", value: 3500, samples: 2 }
    ]);
    expect(aggregateDaily("sleep_duration_minutes", [{ value: 400, observed_at: "2026-11-18T05:00:00Z" }, { value: 40, observed_at: "2026-11-18T07:00:00Z" }])[0]).toMatchObject({ value: 440 });
    expect(aggregateDaily("steps", [{ value: 5, observed_at: "ikke en tid" }, { value: Number.POSITIVE_INFINITY, observed_at: "2026-11-18T05:00:00Z" }])).toEqual([]);
  });

  it("hendelser: kun aktive, ISO-tid, bare feltene bridgen trenger", async () => {
    const read = createIncidentReader({
      incidents: { listIncidents: async () => [
        { incident_id: "i1", title: "A", status: "open", severity: "high", opened_at: new Date("2026-11-19T10:00:00Z") },
        { incident_id: "i2", title: "B", status: "resolved", severity: "low", opened_at: "2026-11-18T10:00:00Z" },
        { incident_id: "i3", title: "C", status: "wont_fix", severity: "low", opened_at: "2026-11-18T10:00:00Z" },
        { incident_id: "i4", title: "D", status: "diagnosing", severity: "critical", opened_at: "ugyldig" }
      ] }
    });
    expect(await read({ ...ctx, memory_space: "business" })).toEqual([{ source: "incident", incident: { incident_id: "i1", title: "A", status: "open", severity: "high", opened_at: "2026-11-19T10:00:00.000Z" } }]);
  });
});

describe("D: kildevakter for koblingsfilen", () => {
  const src = readFileSync(join(ROOT, "apps/api/src/situation-signals-wiring.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("importerer verken helse- eller visjonspakken (porten er strukturell) og nevner aldri helsetabellen; ingen rå nettverkskode", () => {
    expect(code).not.toMatch(/from\s+["']@jarvis\/(health|vision)["']/);
    expect(code).not.toContain("health_metric_observations");
    expect(code).not.toMatch(/(?<![.\w$])fetch\s*\(|XMLHttpRequest|node:https?["']|node:net["']/);
  });

  it("logger aldri observasjoner, verdier eller feilmeldinger (ingen console-kall i filen)", () => {
    expect(code).not.toMatch(/console\.(log|error|warn|info|debug)/);
  });
});
