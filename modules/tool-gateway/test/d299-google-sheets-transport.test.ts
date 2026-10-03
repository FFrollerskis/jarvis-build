import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-299 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - syvende slice). Google Sheets API v4 - gjenbruker den
 * eksisterende `googleAccessToken()` OAuth-refresh-token-utveksleren (stubbes
 * her via `fetch` mot `oauth2.googleapis.com/token`, SAMME mønster som
 * eksisterende Gmail/Calendar/Drive-tester allerede bruker). **Ikke
 * denne-økten-verifisert mot live dokumentasjon** (nettverksegress blokkert,
 * se D-297/D-298/D-299 i DECISIONS_AND_ASSUMPTIONS.md).
 */
function stubGoogleOAuthThenSheets(sheetsResponse: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com/token")) {
      return { ok: true, json: async () => ({ access_token: "test-access-token" }) } as unknown as Response;
    }
    return sheetsResponse as unknown as Response;
  });
  return calls;
}

describe("A: GoogleSheetsTransport.invoke('list_sheets', ...) - GET, INGEN sideeffekt", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "test-client-secret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("kaller GET /v4/spreadsheets/{id}?fields=... med Bearer-header og returnerer fane-titler", async () => {
    const calls = stubGoogleOAuthThenSheets({
      ok: true, json: async () => ({ sheets: [{ properties: { title: "Ark1", sheetId: 0 } }] })
    });
    const transport = new GoogleSheetsTransport();
    const result = await transport.invoke("list_sheets", { spreadsheet_id: "abc123" }, "refresh-token");
    const sheetsCall = calls.find((c) => c.url.includes("sheets.googleapis.com"));
    expect(sheetsCall!.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/abc123?fields=sheets.properties");
    expect(sheetsCall!.init?.headers).toMatchObject({ authorization: "Bearer test-access-token" });
    expect(result.data).toEqual([{ title: "Ark1", sheet_id: 0 }]);
  });

  it("en HTTP-feil kaster 'sheets_error_<status>'", async () => {
    stubGoogleOAuthThenSheets({ ok: false, status: 403, json: async () => ({}) });
    const transport = new GoogleSheetsTransport();
    await expect(transport.invoke("list_sheets", { spreadsheet_id: "abc123" }, "refresh-token")).rejects.toThrow("sheets_error_403");
  });
});

describe("B: GoogleSheetsTransport.invoke('read_range', ...) - GET, INGEN sideeffekt", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "test-client-secret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("kaller GET /v4/spreadsheets/{id}/values/{range} og returnerer 'values'", async () => {
    const calls = stubGoogleOAuthThenSheets({ ok: true, json: async () => ({ values: [["a", "b"], ["c", "d"]] }) });
    const transport = new GoogleSheetsTransport();
    const result = await transport.invoke("read_range", { spreadsheet_id: "abc123", range: "Ark1!A1:B2" }, "refresh-token");
    const sheetsCall = calls.find((c) => c.url.includes("sheets.googleapis.com"));
    expect(sheetsCall!.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/abc123/values/Ark1!A1%3AB2");
    expect(result.data).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("tomt område returnerer tom array, ikke undefined", async () => {
    stubGoogleOAuthThenSheets({ ok: true, json: async () => ({}) });
    const transport = new GoogleSheetsTransport();
    const result = await transport.invoke("read_range", { spreadsheet_id: "abc123", range: "Ark1!Z1" }, "refresh-token");
    expect(result.data).toEqual([]);
  });
});

describe("C: GoogleSheetsTransport.invoke('update_range', ...) - PUT, ekte skrivehandling (klasse B)", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "test-client-secret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("PUTer {range,values} til /v4/spreadsheets/{id}/values/{range}?valueInputOption=RAW", async () => {
    const calls = stubGoogleOAuthThenSheets({ ok: true, json: async () => ({ updatedRange: "Ark1!A1:B1" }) });
    const transport = new GoogleSheetsTransport();
    const result = await transport.invoke(
      "update_range", { spreadsheet_id: "abc123", range: "Ark1!A1:B1", values: [["hei", "verden"]] }, "refresh-token"
    );
    const sheetsCall = calls.find((c) => c.url.includes("sheets.googleapis.com"));
    expect(sheetsCall!.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/abc123/values/Ark1!A1%3AB1?valueInputOption=RAW");
    expect(sheetsCall!.init?.method).toBe("PUT");
    expect(JSON.parse(String(sheetsCall!.init?.body))).toEqual({ range: "Ark1!A1:B1", values: [["hei", "verden"]] });
    expect(result.data).toMatchObject({ updatedRange: "Ark1!A1:B1" });
  });
});

describe("D: GoogleSheetsTransport.invoke('append_row', ...) - POST :append, ekte skrivehandling (klasse B)", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "test-client-secret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("POSTer {range,values:[[row]]} til .../values/{range}:append?valueInputOption=RAW", async () => {
    const calls = stubGoogleOAuthThenSheets({ ok: true, json: async () => ({ updates: { updatedRange: "Ark1!A5:B5" } }) });
    const transport = new GoogleSheetsTransport();
    const result = await transport.invoke(
      "append_row", { spreadsheet_id: "abc123", range: "Ark1!A:B", row: ["ny", "rad"] }, "refresh-token"
    );
    const sheetsCall = calls.find((c) => c.url.includes("sheets.googleapis.com"));
    expect(sheetsCall!.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/abc123/values/Ark1!A%3AB:append?valueInputOption=RAW");
    expect(sheetsCall!.init?.method).toBe("POST");
    expect(JSON.parse(String(sheetsCall!.init?.body))).toEqual({ range: "Ark1!A:B", values: [["ny", "rad"]] });
    expect(result.external_id).toBe("Ark1!A5:B5");
  });
});

describe("E: en ukjent handling kaster 'sheets_unsupported_action_<action>'", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "test-client-secret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("invoke('delete_sheet', ...) kaster", async () => {
    stubGoogleOAuthThenSheets({ ok: true, json: async () => ({}) });
    await expect(new GoogleSheetsTransport().invoke("delete_sheet", { spreadsheet_id: "abc123" }, "refresh-token")).rejects.toThrow("sheets_unsupported_action_delete_sheet");
  });
});

describe("F: firstWaveTools() registrerer alle fire google_sheets.*-handlinger med korrekt risikoklasse", () => {
  it("google_sheets.update_range/append_row er begge klasse B (ekte skrivehandlinger)", () => {
    const tools = firstWaveTools();
    for (const action of ["update_range", "append_row"]) {
      const tool = tools.find((t) => t.tool_id === "google_sheets" && t.action === action);
      expect(tool, `google_sheets.${action} skal finnes`).toBeDefined();
      expect(tool!.capability_class).toBe("B");
      expect(tool!.credential_ref).toBe("JARVIS_GOOGLE_SHEETS_TOKEN");
    }
  });

  it("google_sheets.list_sheets/read_range er begge klasse A (lesing)", () => {
    const tools = firstWaveTools();
    for (const action of ["list_sheets", "read_range"]) {
      const tool = tools.find((t) => t.tool_id === "google_sheets" && t.action === action);
      expect(tool, `google_sheets.${action} skal finnes`).toBeDefined();
      expect(tool!.capability_class).toBe("A");
    }
  });
});
