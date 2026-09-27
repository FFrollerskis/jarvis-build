import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleMapsTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-298 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - sjette slice). Google Maps Platform sitt Geocoding-API -
 * API-nøkkel som `key`-query-parameter (ULIK Brave Search sin header).
 * **Ikke denne-økten-verifisert mot live dokumentasjon** (nettverksegress
 * blokkert, se D-297/D-298 i DECISIONS_AND_ASSUMPTIONS.md) - testene under
 * bekrefter KODEN sin egen oppførsel, ikke at formen matcher Google sitt
 * ekte API.
 */
describe("A: GoogleMapsTransport.invoke('geocode', ...) - GET, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /maps/api/geocode/json?address=...&key=... og returnerer hele svaret som data", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ status: "OK", results: [{ formatted_address: "1600 Amphitheatre Pkwy" }] }) } as unknown as Response;
    });
    const transport = new GoogleMapsTransport();
    const result = await transport.invoke("geocode", { address: "1600 Amphitheatre Parkway, Mountain View, CA" }, "test-key");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/geocode/json");
    expect(url.searchParams.get("address")).toBe("1600 Amphitheatre Parkway, Mountain View, CA");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(result.data).toMatchObject({ status: "OK" });
  });

  it("en HTTP-feil kaster 'google_maps_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403 }) as unknown as Response);
    const transport = new GoogleMapsTransport();
    await expect(transport.invoke("geocode", { address: "x" }, "bad-key")).rejects.toThrow("google_maps_error_403");
  });

  it("Google sin egen status !== 'OK' (f.eks. ZERO_RESULTS) kastes IKKE - returneres rått i data", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ status: "ZERO_RESULTS", results: [] }) }) as unknown as Response);
    const transport = new GoogleMapsTransport();
    const result = await transport.invoke("geocode", { address: "nonexistent place xyz" }, "test-key");
    expect(result.data).toMatchObject({ status: "ZERO_RESULTS", results: [] });
  });
});

describe("B: GoogleMapsTransport.invoke('reverse_geocode', ...) - GET, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /maps/api/geocode/json?latlng=...&key=...", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ status: "OK", results: [] }) } as unknown as Response;
    });
    await new GoogleMapsTransport().invoke("reverse_geocode", { latlng: "37.4224764,-122.0842499" }, "test-key");
    const url = new URL(calls[0]!);
    expect(url.searchParams.get("latlng")).toBe("37.4224764,-122.0842499");
    expect(url.searchParams.get("key")).toBe("test-key");
  });
});

describe("C: en ukjent handling kaster 'google_maps_unsupported_action_<action>'", () => {
  it("invoke('directions', ...) kaster", async () => {
    await expect(new GoogleMapsTransport().invoke("directions", {}, "test-key")).rejects.toThrow("google_maps_unsupported_action_directions");
  });
});

describe("D: firstWaveTools() registrerer begge google_maps.*-handlingene som klasse A (lesing)", () => {
  it("google_maps.geocode/reverse_geocode er begge klasse A", () => {
    const tools = firstWaveTools();
    for (const action of ["geocode", "reverse_geocode"]) {
      const tool = tools.find((t) => t.tool_id === "google_maps" && t.action === action);
      expect(tool, `google_maps.${action} skal finnes`).toBeDefined();
      expect(tool!.capability_class).toBe("A");
      expect(tool!.credential_ref).toBe("JARVIS_GOOGLE_MAPS_API_KEY");
    }
  });
});
