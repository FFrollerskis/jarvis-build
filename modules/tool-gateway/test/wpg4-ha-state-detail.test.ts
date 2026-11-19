import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAssistantTransport } from "../src/home-assistant-transport.ts";
import { homeAssistantStateDetailTool, homeAssistantTools } from "../src/home-assistant.ts";
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

describe("A: transporten gir KUN state/last_changed/device_class (lukkede nøkler, kuttet lengde)", () => {
  it("GET /api/states/<entitet> med Bearer; attributter, navn og historikk forlater aldri transporten", async () => {
    const calls = stubFetch(() => ({
      json: { entity_id: "binary_sensor.inngang", state: "on", last_changed: "2026-11-19T11:30:00.123456+00:00", last_updated: "x", context: { id: "abc", user_id: "u" },
        attributes: { device_class: "door", friendly_name: "Hemmelig navn", latitude: 59.9, secret_token_attr: "x" } }
    }));
    const r = await transport().invoke("read_state_detail", { entity: "binary_sensor.inngang" }, "ha-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://ha.local:8123/api/states/binary_sensor.inngang");
    expect(calls[0]!.init?.method).toBe("GET");
    expect((calls[0]!.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer ha-token");
    expect(r.data).toEqual({ entity_id: "binary_sensor.inngang", state: "on", last_changed: "2026-11-19T11:30:00.123456+00:00", device_class: "door" });
    expect(JSON.stringify(r.data)).not.toMatch(/Hemmelig|59\.9|secret|abc/);
  });

  it("ukjent entitet (404) gir data:null; for lange/ikke-tekst-felt blir null; ugyldig entitets-id kaster FØR noe nettverkskall", async () => {
    stubFetch(() => ({ status: 404 }));
    expect((await transport().invoke("read_state_detail", { entity: "binary_sensor.finnes_ikke" }, "t")).data).toBeNull();
    stubFetch(() => ({ json: { state: "x".repeat(200), last_changed: 5, attributes: { device_class: ["door"] } } }));
    expect((await transport().invoke("read_state_detail", { entity: "sensor.a" }, "t")).data).toEqual({ entity_id: "sensor.a", state: null, last_changed: null, device_class: null });
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
