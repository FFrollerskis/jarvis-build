import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAssistantTransport } from "../src/home-assistant-transport.ts";
import { homeAssistantSituationReadTools, homeAssistantStateDetailTool, homeAssistantStatesDetailTool, homeAssistantTools } from "../src/home-assistant.ts";
import { firstWaveTools } from "../src/integrations.ts";
import { assertManifestInvariants, buildToolManifest } from "../src/tool-manifest.ts";

/**
 * WP-G4 (D-466): den ene nye LESE-handlingen på den eksisterende Home Assistant-connectoren (`read_state_detail`), brukt av situasjonsmotorens hjem-bro. Klasse A, minimert utdata, ingen nettverk (global `fetch` er stubbet).
 * Registreringen er separat fra `homeAssistantTools()` (flagg AV = verktøylisten er identisk med main): vaktet her.
 */
type Call = { url: string; init: RequestInit | undefined };
function stubFetch(handler: (url: string) => { status?: number; json?: unknown; text?: string }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url);
    const status = r.status ?? 200;
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), arrayBuffer: async () => Buffer.from(text), body: null };
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const transport = () => new HomeAssistantTransport(async () => "http://ha.local:8123/", async () => "{}");

describe("A: transporten gir KUN state/last_changed/unit (lukkede nøkler, kuttet lengde)", () => {
  it("GET /api/states/<entitet> med Bearer; attributter, navn og historikk forlater aldri transporten", async () => {
    const calls = stubFetch(() => ({
      json: { entity_id: "binary_sensor.inngang", state: "on", last_changed: "2026-11-19T11:30:00.123456+00:00", last_updated: "x", context: { id: "abc", user_id: "u" },
        attributes: { device_class: "door", unit_of_measurement: "W", friendly_name: "Hemmelig navn", latitude: 59.9, secret_token_attr: "x" } }
    }));
    const r = await transport().invoke("read_state_detail", { entity: "binary_sensor.inngang" }, "ha-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://ha.local:8123/api/states/binary_sensor.inngang");
    expect(calls[0]!.init?.method).toBe("GET");
    expect((calls[0]!.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer ha-token");
    expect(r.data).toEqual({ entity_id: "binary_sensor.inngang", state: "on", last_changed: "2026-11-19T11:30:00.123456+00:00", unit: "W" });
    expect(JSON.stringify(r.data)).not.toMatch(/Hemmelig|59\.9|secret|abc/);
  });

  it("ukjent entitet (404) gir data:null; for lange/ikke-tekst-felt blir null; ugyldig entitets-id kaster FØR noe nettverkskall", async () => {
    stubFetch(() => ({ status: 404 }));
    expect((await transport().invoke("read_state_detail", { entity: "binary_sensor.finnes_ikke" }, "t")).data).toBeNull();
    stubFetch(() => ({ json: { state: "x".repeat(200), last_changed: 5, attributes: { unit_of_measurement: ["W"] } } }));
    expect((await transport().invoke("read_state_detail", { entity: "sensor.a" }, "t")).data).toEqual({ entity_id: "sensor.a", state: null, last_changed: null, unit: null });
    const calls = stubFetch(() => ({ json: {} }));
    for (const bad of ["x;rm -rf", "BINARY.sensor", "binary_sensor", "../etc", 5, undefined]) await expect(transport().invoke("read_state_detail", { entity: bad as never }, "t")).rejects.toThrow(/home_invalid_entity_id/);
    expect(calls).toHaveLength(0);
  });

  it("feilstatus og manglende base-URL kaster (kilden er utilgjengelig - aldri en stille tom verdi)", async () => {
    stubFetch(() => ({ status: 503 }));
    await expect(transport().invoke("read_state_detail", { entity: "sensor.a" }, "t")).rejects.toThrow("home_assistant_error_503");
    await expect(new HomeAssistantTransport(async () => null, async () => "{}").invoke("read_state_detail", { entity: "sensor.a" }, "t")).rejects.toThrow("home_assistant_base_url_not_configured");
  });
});

describe("B: verktøydefinisjonen - klasse A, ren lesing, og IKKE en del av homeAssistantTools() (flagg AV = main)", () => {
  it("homeAssistantTools() er UENDRET (de seks eksisterende handlingene); lese-handlingen har egen funksjon", () => {
    expect(homeAssistantTools({ invoke: async () => ({}) }).map((t) => t.action).sort()).toEqual(["alarm_set", "climate_set", "light_set", "list_states", "lock_set", "read_state"]);
    expect(homeAssistantStateDetailTool({ invoke: async () => ({}) })).toMatchObject({
      tool_id: "home-assistant", action: "read_state_detail", capability_class: "A", scopes: ["states:read"], output_trust: "untrusted", credential_ref: "JARVIS_HA_TOKEN", reversible: true, idempotent_external: true
    });
  });

  it("inndata er strict: kun `entity` med eksakt HA-id; identitets-/ekstrafelt avvises", () => {
    const schema = homeAssistantStateDetailTool({ invoke: async () => ({}) }).input_schema;
    expect(schema.safeParse({ entity: "binary_sensor.inngang" }).success).toBe(true);
    for (const bad of [{}, { entity: "*" }, { entity: "binary_sensor.a", tenant_id: "x" }, { entity: "Binary.a" }, { entity: "a.b", extra: 1 }]) expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("manifest-invariantene består med den nye handlingen: effekt `read`, klasse A, ingen modellflate", () => {
    const manifest = buildToolManifest([...firstWaveTools(), ...homeAssistantTools({ invoke: async () => ({}) }), homeAssistantStateDetailTool({ invoke: async () => ({}) })]);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    const entry = manifest.get("home-assistant.read_state_detail");
    expect(entry).toMatchObject({ effect: "read", risk: "A", surfaces: [] });
  });
});

describe("C: read_states_detail - ÉN gateway-kjøring for alle abonnerte entiteter (fiks-runde B-MEDIUM-4: 1 revisjonsrad per tikk i stedet for 1 per entitet)", () => {
  const ok = (id: string, state = "on") => ({ json: { entity_id: id, state, last_changed: "2026-11-19T11:30:00+00:00", attributes: { ...(id.startsWith("sensor.") ? { unit_of_measurement: "kW" } : {}), friendly_name: "Skjult" } } });

  it("hver entitet leses (GET) i rekkefølge med minimert utdata; ukjent entitet (404) = null; en enkeltfeil = {entity_id, error} uten at resten går tapt", async () => {
    const calls = stubFetch((url) => (url.endsWith("/binary_sensor.ukjent") ? { status: 404 } : url.endsWith("/binary_sensor.feil") ? { status: 500 } : ok(url.split("/").pop() as string)));
    const r = await transport().invoke("read_states_detail", { entities: ["binary_sensor.inngang", "binary_sensor.ukjent", "binary_sensor.feil", "sensor.ovn"] }, "ha-token");
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["binary_sensor.inngang", "binary_sensor.ukjent", "binary_sensor.feil", "sensor.ovn"]);
    expect(calls.every((c) => (c.init?.headers as Record<string, string>)["authorization"] === "Bearer ha-token" && c.init?.method === "GET")).toBe(true);
    expect(r.data).toEqual({
      states: [
        { entity_id: "binary_sensor.inngang", state: "on", last_changed: "2026-11-19T11:30:00+00:00", unit: null },
        null,
        { entity_id: "binary_sensor.feil", error: "home_assistant_error_500" },
        { entity_id: "sensor.ovn", state: "on", last_changed: "2026-11-19T11:30:00+00:00", unit: "kW" }
      ]
    });
    expect(JSON.stringify(r.data)).not.toMatch(/Skjult/);
  });

  it("feiler ALLE leser (HA nede) kastes den første feilen - en synlig kildefeil, ikke en tom liste", async () => {
    stubFetch(() => ({ status: 503 }));
    await expect(transport().invoke("read_states_detail", { entities: ["sensor.a", "sensor.b"] }, "t")).rejects.toThrow("home_assistant_error_503");
    await expect(new HomeAssistantTransport(async () => null, async () => "{}").invoke("read_states_detail", { entities: ["sensor.a"] }, "t")).rejects.toThrow("home_assistant_base_url_not_configured");
  });

  it("ugyldig inndata (ikke en liste, tom, over 50, ugyldig id) kaster FØR noe nettverkskall; nøyaktig 50 er tillatt", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    const fifty = Array.from({ length: 51 }, (_, i) => `sensor.s${i}`);
    for (const bad of [undefined, "sensor.a", [], fifty, ["sensor.a", "x;rm"], ["sensor.a", 5]]) await expect(transport().invoke("read_states_detail", { entities: bad as never }, "t")).rejects.toThrow(/home_invalid_entity_id/);
    expect(calls).toHaveLength(0);
    stubFetch((url) => ok(url.split("/").pop() as string));
    expect(((await transport().invoke("read_states_detail", { entities: fifty.slice(0, 50) }, "t")).data as { states: unknown[] }).states).toHaveLength(50);
  });

  it("verktøydefinisjonen: klasse A, ren lesing, strict 1-50 entiteter, egen funksjon; `homeAssistantSituationReadTools` gir begge handlingene; manifest-invariantene består", () => {
    const def = homeAssistantStatesDetailTool({ invoke: async () => ({}) });
    expect(def).toMatchObject({ tool_id: "home-assistant", action: "read_states_detail", capability_class: "A", scopes: ["states:read"], output_trust: "untrusted", credential_ref: "JARVIS_HA_TOKEN", reversible: true, idempotent_external: true });
    expect(homeAssistantSituationReadTools({ invoke: async () => ({}) }).map((t) => t.action)).toEqual(["read_state_detail", "read_states_detail"]);
    const schema = def.input_schema;
    expect(schema.safeParse({ entities: ["binary_sensor.inngang"] }).success).toBe(true);
    for (const bad of [{}, { entities: [] }, { entities: ["*"] }, { entities: Array.from({ length: 51 }, (_, i) => `sensor.s${i}`) }, { entities: ["a.b"], tenant_id: "x" }, { entity: "a.b" }]) expect(schema.safeParse(bad).success, JSON.stringify(bad).slice(0, 50)).toBe(false);
    const manifest = buildToolManifest([...firstWaveTools(), ...homeAssistantTools({ invoke: async () => ({}) }), ...homeAssistantSituationReadTools({ invoke: async () => ({}) })]);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    expect(manifest.get("home-assistant.read_states_detail")).toMatchObject({ effect: "read", risk: "A", surfaces: [] });
  });
});
