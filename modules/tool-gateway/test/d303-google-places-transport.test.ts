import { afterEach, describe, expect, it, vi } from "vitest";
import { GooglePlacesTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-303 (bygget parallelt mens D-302 sin CI kjørte). SAMME D-64-
 * domenevurdering som Google Maps (D-298): stateless tredjeparts-
 * stedoppslag. Bruker det ELDRE, langvarig stabile Places-API-et
 * (`key`-query-parameter), SAMME autentiseringsform som Google Maps
 * Geocoding.
 */
describe("A: GooglePlacesTransport.invoke('search_places', ...) - GET /place/textsearch/json, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med query og key som query-parametere, returnerer hele JSON-responsen", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ status: "OK", results: [{ name: "Eiffel Tower" }] }) } as unknown as Response;
    });
    const result = await new GooglePlacesTransport().invoke("search_places", { query: "Eiffel Tower" }, "test-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://maps.googleapis.com/maps/api/place/textsearch/json?query=Eiffel+Tower&key=test-key");
    expect(result.data).toEqual({ status: "OK", results: [{ name: "Eiffel Tower" }] });
  });

  it("en ikke-OK status i svaret kaster IKKE - returneres rått til kalleren", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ status: "ZERO_RESULTS", results: [] }) }) as unknown as Response);
    const result = await new GooglePlacesTransport().invoke("search_places", { query: "asdkjaslkdj" }, "tok");
    expect(result.data).toEqual({ status: "ZERO_RESULTS", results: [] });
  });

  it("en HTTP-feil kaster 'google_places_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403 }) as unknown as Response);
    await expect(new GooglePlacesTransport().invoke("search_places", { query: "hei" }, "bad-key")).rejects.toThrow("google_places_error_403");
  });
});

describe("B: GooglePlacesTransport.invoke('get_place_details', ...) - GET /place/details/json", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med place_id og key, returnerer hele JSON-responsen", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ status: "OK", result: { name: "Eiffel Tower" } }) } as unknown as Response;
    });
    const result = await new GooglePlacesTransport().invoke("get_place_details", { place_id: "ChIJ123" }, "tok");
    expect(calls[0]).toBe("https://maps.googleapis.com/maps/api/place/details/json?place_id=ChIJ123&key=tok");
    expect(result.data).toEqual({ status: "OK", result: { name: "Eiffel Tower" } });
  });
});

describe("C: en ukjent handling kaster 'google_places_unsupported_action_<action>'", () => {
  it("invoke('nearby_search', ...) kaster (ikke registrert, selv om Places-API-et tilbyr det)", async () => {
    await expect(new GooglePlacesTransport().invoke("nearby_search", { query: "hei" }, "tok")).rejects.toThrow("google_places_unsupported_action_nearby_search");
  });
});

describe("D: firstWaveTools() registrerer begge google_places.*-handlinger som klasse A (lesing)", () => {
  it("google_places.search_places og get_place_details er begge klasse A, ingen klasse B/C/D-handling finnes for denne connectoren", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "google_places");
    expect(tools.map((t) => t.action).sort()).toEqual(["get_place_details", "search_places"]);
    for (const tool of tools) {
      expect(tool.capability_class).toBe("A");
      expect(tool.credential_ref).toBe("JARVIS_GOOGLE_PLACES_API_KEY");
      expect(tool.output_trust).toBe("untrusted");
    }
  });
});
