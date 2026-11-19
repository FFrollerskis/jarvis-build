import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { ToolGateway } from "@jarvis/tool-gateway";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  aggregateDaily, createHealthReader, createHomeReader, createIncidentReader, createSituationSignalsWiring, createVisionReader, wattsOf, type SituationSignalsWiringDeps
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
    expect(home.tools.map((t) => `${t.tool_id}.${t.action}`)).toEqual(expect.arrayContaining(["home-assistant.read_state_detail", "home-assistant.read_states_detail"]));
    expect(home.describe()).toMatchObject({ interval_seconds: 60, log_retention_days: 30, spaces: ["home"], sources: { home: true } });
    const all = createSituationSignalsWiring(deps({
      JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_VISION: "on", JARVIS_SITUATION_HEALTH: "on", JARVIS_SITUATION_INCIDENTS: "on", JARVIS_SITUATION_BUS_INTERVAL_SECONDS: "120", JARVIS_SITUATION_LOG_RETENTION_DAYS: "90"
    }));
    expect(all.describe()).toMatchObject({ interval_seconds: 120, log_retention_days: 90, sources: { home: false, vision: true, health: true, incidents: true } });
    expect((all.describe() as { spaces: string[] }).spaces.sort()).toEqual(["business", "health", "home"]);
    expect(all.tools.map((t) => t.action)).not.toContain("read_state_detail");
    expect(all.tools.map((t) => t.action)).not.toContain("read_states_detail");
  });
});

describe("B: hjem-leseren - kun abonnerte entiteter via ToolGateway, effekt-teller i minnet, synlig kildefeil", () => {
  const calls: Array<{ identity: IdentityContext; tool_id: string; action: string; parameters: Record<string, unknown> }> = [];
  /** Gateway-stub for den SAMLEDE lese-handlingen: handleren får entitetslisten og gir hele resultatet (fiks-runde B-MEDIUM-4: ÉN kjøring per tikk). */
  const gatewayWith = (handler: (entities: string[]) => unknown): Pick<ToolGateway, "execute"> => ({
    execute: async (req: never) => {
      const r = req as { identity: IdentityContext; tool_id: string; action: string; parameters: { entities: string[] } };
      calls.push({ identity: r.identity, tool_id: r.tool_id, action: r.action, parameters: r.parameters });
      return handler(r.parameters.entities) as never;
    }
  });
  const okStates = (states: unknown[]) => ({ ok: true, data: { states }, output_trust: "untrusted", deduplicated: false });
  const detail = (entity: string, state = "on", extra: Record<string, unknown> = {}) => ({ entity_id: entity, state, last_changed: "2026-11-19T11:00:00.000Z", unit: null, ...extra });
  const ctx = (now = NOW, warnings?: string[]) => ({ tenant_id: "t-owner", memory_space: "home" as MemorySpace, now, ...(warnings ? { warnings } : {}) });

  it("ÉN gateway-kjøring for alle entiteter (ikke én per entitet) med riktig verktøy/handling og eierens identitet i kildens rom; kun {entities} sendes", async () => {
    calls.length = 0;
    const read = createHomeReader({ gateway: gatewayWith((entities) => okStates(entities.map((e) => detail(e)))), identityFor });
    const out = await read(ctx(), [{ entity_id: "binary_sensor.inngang", role: "door" }, { entity_id: "binary_sensor.kjeller", role: "leak" }]);
    expect(calls.map((c) => [c.tool_id, c.action, c.parameters])).toEqual([["home-assistant", "read_states_detail", { entities: ["binary_sensor.inngang", "binary_sensor.kjeller"] }]]);
    expect(calls[0]!.identity).toMatchObject({ person_id: OWNER, tenant_id: "t-owner", memory_space_id: "home" });
    expect(out).toEqual([
      { source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: "2026-11-19T11:00:00.000Z" },
      { source: "home_assistant", entity_id: "binary_sensor.kjeller", role: "leak", state: "on", last_changed: "2026-11-19T11:00:00.000Z" }
    ]);
    calls.length = 0;
    expect(await read(ctx(), [])).toEqual([]);
    expect(calls).toHaveLength(0); // ingen entiteter = ingen gateway-kjøring
  });

  it("ukjent entitet (null), enkeltfeil og misformet svar hoppes over uten feil og blir synlige ADVARSLER (aldri stille uvirksomt); hele kallet feilet eller ugyldig svar er en kildefeil (`home_source_unavailable`)", async () => {
    const warnings: string[] = [];
    const mixed = createHomeReader({
      gateway: gatewayWith(() => okStates([null, { entity_id: "binary_sensor.b", error: "home_assistant_error_500" }, { entity_id: "binary_sensor.c", state: 5, last_changed: null }, detail("binary_sensor.d", "off")])), identityFor
    });
    const out = await mixed(ctx(NOW, warnings), ["a", "b", "c", "d"].map((x) => ({ entity_id: `binary_sensor.${x}`, role: "door" as const })));
    expect(out).toEqual([{ source: "home_assistant", entity_id: "binary_sensor.d", role: "door", state: "off", last_changed: "2026-11-19T11:00:00.000Z" }]);
    expect(warnings).toEqual(["home_entities_unknown:1", "home_entities_failed:2"]);
    // uten advarselsliste (eldre kaller) er det samme resultat, bare uten advarsler
    expect(await mixed(ctx(), ["a", "b", "c", "d"].map((x) => ({ entity_id: `binary_sensor.${x}`, role: "door" as const })))).toHaveLength(1);
    for (const gateway of [
      gatewayWith(() => ({ ok: false, reason: "credential_unavailable" })),
      gatewayWith(() => okStates([detail("binary_sensor.a")])), // feil antall svar
      gatewayWith(() => ({ ok: true, data: null, output_trust: "untrusted", deduplicated: false })),
      gatewayWith(() => ({ ok: true, data: { states: "ikke en liste" }, output_trust: "untrusted", deduplicated: false }))
    ]) {
      await expect(createHomeReader({ gateway, identityFor })(ctx(), [{ entity_id: "binary_sensor.a", role: "door" }, { entity_id: "binary_sensor.b", role: "door" }])).rejects.toThrow("home_source_unavailable");
    }
  });

  it("effekt: telleren øker bare mens verdien ligger OVER eierens grense, beholder startpunktet, og nullstilles når den faller under", async () => {
    let watts = "2500";
    const read = createHomeReader({ gateway: gatewayWith((list) => okStates(list.map((e) => ({ entity_id: e, state: watts, last_changed: "2026-11-19T11:59:00.000Z", unit: "W" })))), identityFor });
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

describe("B2: effektenhet (B-LOW-9) - W og kW sammenlignes riktig mot eierens grense i watt, andre enheter gir ingen påstand", () => {
  const ctx = (now = NOW) => ({ tenant_id: "t-owner", memory_space: "home" as MemorySpace, now });
  const entities = [{ entity_id: "sensor.ovn", role: "power" as const, limit_w: 2000 }];
  const readWith = (state: string, unit: unknown) => createHomeReader({
    gateway: { execute: async () => ({ ok: true, data: { states: [{ entity_id: "sensor.ovn", state, last_changed: "2026-11-19T11:59:00.000Z", unit }] }, output_trust: "untrusted", deduplicated: false }) as never },
    identityFor
  });

  it("wattsOf: W (og manglende enhet) som den er, kW x 1000, alt annet = ukjent", () => {
    expect([wattsOf("1500", "W"), wattsOf("1500", null), wattsOf("1500", undefined), wattsOf("1.2", "kW"), wattsOf("2.5", "kW")]).toEqual([1500, 1500, 1500, 1200, 2500]);
    for (const bad of [["1.2", "MW"], ["1.2", "A"], ["50", "%"], ["unavailable", "W"], ["", "kW"], ["1.2", 5]] as const) expect(wattsOf(bad[0], bad[1]), bad.join("|")).toBeNull();
  });

  it("en sensor i kW (1,2 kW = 1200 W) er UNDER grensen på 2000 W (normal), 2,5 kW er OVER; en ukjent enhet er verken over eller normal", async () => {
    expect((await readWith("1.2", "kW")(ctx(), entities))[0]).toMatchObject({ over_limit_ticks: 0, limit_w: 2000 });
    expect((await readWith("2.5", "kW")(ctx(), entities))[0]).toMatchObject({ over_limit_ticks: 1, limit_w: 2000 });
    const unknownUnit = (await readWith("2500", "MW")(ctx(), entities))[0] as unknown as Record<string, unknown>;
    expect(unknownUnit).toMatchObject({ role: "power", state: "2500" });
    expect(unknownUnit["over_limit_ticks"]).toBeUndefined();
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
