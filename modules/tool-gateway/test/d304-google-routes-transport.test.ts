import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleRoutesTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-304 (bygget parallelt mens D-303 sin CI kjørte - fullfører "Google-
 * lokasjons-trioen" Maps/Places/Routes). SAMME D-64-domenevurdering som
 * Google Maps/Google Places: stateless tredjeparts-rute-oppslag. Bruker det
 * ELDRE, langvarig stabile Directions-/Distance Matrix-API-et
 * (`key`-query-parameter), SAMME autentiseringsform som Google Maps/Places.
 */
describe("A: GoogleRoutesTransport.invoke('get_directions', ...) - GET /directions/json, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med origin/destination og key som query-parametere, returnerer hele JSON-responsen", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ status: "OK", routes: [{ summary: "via A1" }] }) } as unknown as Response;
    });
    const result = await new GoogleRoutesTransport().invoke("get_directions", { origin: "Paris, France", destination: "Versailles, France" }, "test-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://maps.googleapis.com/maps/api/directions/json?origin=Paris%2C+France&destination=Versailles%2C+France&key=test-key");
    expect(result.data).toEqual({ status: "OK", routes: [{ summary: "via A1" }] });
  });

  it("en ikke-OK status i svaret kaster IKKE - returneres rått til kalleren", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ status: "ZERO_RESULTS", routes: [] }) }) as unknown as Response);
    const result = await new GoogleRoutesTransport().invoke("get_directions", { origin: "asdkjaslkdj", destination: "asdasd" }, "tok");
    expect(result.data).toEqual({ status: "ZERO_RESULTS", routes: [] });
  });

  it("en HTTP-feil kaster 'google_routes_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403 }) as unknown as Response);
    await expect(new GoogleRoutesTransport().invoke("get_directions", { origin: "hei", destination: "hoi" }, "bad-key")).rejects.toThrow("google_routes_error_403");
  });
});

describe("B: GoogleRoutesTransport.invoke('get_distance_matrix', ...) - GET /distancematrix/json", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med origins/destinations og key, returnerer hele JSON-responsen", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ status: "OK", rows: [{ elements: [{ distance: { text: "10 km" } }] }] }) } as unknown as Response;
    });
    const result = await new GoogleRoutesTransport().invoke("get_distance_matrix", { origins: "Paris", destinations: "Versailles" }, "tok");
    expect(calls[0]).toBe("https://maps.googleapis.com/maps/api/distancematrix/json?origins=Paris&destinations=Versailles&key=tok");
    expect(result.data).toEqual({ status: "OK", rows: [{ elements: [{ distance: { text: "10 km" } }] }] });
  });
});

describe("C: en ukjent handling kaster 'google_routes_unsupported_action_<action>'", () => {
  it("invoke('optimize_waypoints', ...) kaster (ikke registrert, selv om Directions-API-et tilbyr det)", async () => {
    await expect(new GoogleRoutesTransport().invoke("optimize_waypoints", { origin: "hei" }, "tok")).rejects.toThrow("google_routes_unsupported_action_optimize_waypoints");
  });
});

describe("D: firstWaveTools() registrerer begge google_routes.*-handlinger som klasse A (lesing)", () => {
  it("google_routes.get_directions og get_distance_matrix er begge klasse A, ingen klasse B/C/D-handling finnes for denne connectoren", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "google_routes");
    expect(tools.map((t) => t.action).sort()).toEqual(["get_directions", "get_distance_matrix"]);
    for (const tool of tools) {
      expect(tool.capability_class).toBe("A");
      expect(tool.credential_ref).toBe("JARVIS_GOOGLE_ROUTES_API_KEY");
      expect(tool.output_trust).toBe("untrusted");
    }
  });
});
