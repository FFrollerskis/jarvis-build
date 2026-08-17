import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDriveTransport, driveTransportsIfConfigured, googleDriveCredentialsConfigured } from "@jarvis/tool-gateway";

/**
 * UA-2 P1A scope-endring (2026-08-16) §K/§L: `GoogleDriveTransport` sin EGEN
 * interne logikk (optimistic-concurrency-precondition, HTTP-status→typet-feil-
 * klassifisering, idempotent 404-håndtering på sletting) kan IKKE bevises via
 * `FakeTransport` (den substituerer HELE transporten - se
 * `drive-full-access.test.ts` for policy/idempotency/isolasjon-bevis der).
 * UA-2 P1B-A (2026-08-16): IKKE lenger den eneste fetch-mockede transport-
 * testen - `gmail-attachment-transport.test.ts` fikk samme unntak da
 * `GmailTransport` fikk reell intern logikk (rekursiv MIME-tre-vedlegg-
 * gjenfinning, base64url-konvertering). Calendar/GitHub sine rå HTTP-
 * transportere forblir "typesjekket, IKKE unit-testet - kun live-verifisert"
 * (se toppen av live-transports.ts) - de har fortsatt ingen egen intern
 * logikk utover rett fetch→JSON-mapping som krever et deterministisk bevis.
 */
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GoogleDriveTransport - intern logikk (fetch mocket)", () => {
  let calls: Array<{ url: string; method: string }>;
  let queue: Response[];

  beforeEach(() => {
    calls = [];
    queue = [];
    global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse(200, { access_token: "fake-access-token" });
      }
      const next = queue.shift();
      if (!next) throw new Error(`uventet fetch-kall uten kø-oppføring: ${url}`);
      return next;
    }) as unknown as typeof fetch;
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "test-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "test-client-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("K: update_content med expected_head_revision_id SOM MATCHER kaller PATCH normalt", async () => {
    queue.push(jsonResponse(200, { id: "f1", name: "f1", mimeType: "text/plain", trashed: false, parents: [], headRevisionId: "rev-A", modifiedTime: "2026-08-16T00:00:00Z" }));
    queue.push(jsonResponse(200, { id: "f1", name: "f1", headRevisionId: "rev-B" }));
    const transport = new GoogleDriveTransport();
    const result = await transport.invoke("update_content", { file_id: "f1", content: "nytt", expected_head_revision_id: "rev-A" }, "refresh-token");
    expect(result.external_id).toBe("f1");
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("K: update_content med expected_head_revision_id som IKKE matcher kaster drive_conflict_stale_version FØR noen PATCH forsøkes", async () => {
    queue.push(jsonResponse(200, { id: "f1", name: "f1", mimeType: "text/plain", trashed: false, parents: [], headRevisionId: "rev-FAKTISK", modifiedTime: "2026-08-16T00:00:00Z" }));
    const transport = new GoogleDriveTransport();
    await expect(
      transport.invoke("update_content", { file_id: "f1", content: "nytt", expected_head_revision_id: "rev-FORVENTET-MEN-UTDATERT" }, "refresh-token")
    ).rejects.toThrow(/drive_conflict_stale_version/);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false); // ALDRI en mutasjon forsøkt etter konflikt oppdaget
  });

  it("K: rename/move/trash respekterer SAMME precondition-sjekk som update_content", async () => {
    queue.push(jsonResponse(200, { id: "f1", name: "gammelt", mimeType: "text/plain", trashed: false, parents: [], headRevisionId: "rev-X", modifiedTime: "2026-08-16T00:00:00Z" }));
    const transport = new GoogleDriveTransport();
    await expect(
      transport.invoke("rename", { file_id: "f1", new_name: "nytt", expected_head_revision_id: "rev-UTDATERT" }, "refresh-token")
    ).rejects.toThrow(/drive_conflict_stale_version/);
  });

  it("K: INGEN expected_head_revision_id oppgitt - ingen precondition-sjekk, mutasjon kjører direkte", async () => {
    queue.push(jsonResponse(200, { id: "f1", name: "nytt-navn" }));
    const transport = new GoogleDriveTransport();
    const result = await transport.invoke("rename", { file_id: "f1", new_name: "nytt-navn" }, "refresh-token");
    expect(result.external_id).toBe("f1");
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("/files/f1")).length).toBe(0); // ingen get_metadata-preflight kalt av transporten selv
  });

  it("L: 404 på get_metadata klassifiseres som drive_not_found_<id>", async () => {
    queue.push(jsonResponse(404, {}));
    const transport = new GoogleDriveTransport();
    await expect(transport.invoke("get_metadata", { file_id: "missing-1" }, "refresh-token")).rejects.toThrow("drive_not_found_missing-1");
  });

  it("L: 401/403 klassifiseres som drive_auth_error_<status>", async () => {
    queue.push(jsonResponse(401, {}));
    const transport = new GoogleDriveTransport();
    await expect(transport.invoke("get_metadata", { file_id: "f1" }, "refresh-token")).rejects.toThrow("drive_auth_error_401");
  });

  it("L: 429 klassifiseres som drive_rate_limited", async () => {
    queue.push(jsonResponse(429, {}));
    const transport = new GoogleDriveTransport();
    await expect(transport.invoke("list_files", {}, "refresh-token")).rejects.toThrow("drive_rate_limited");
  });

  it("L: 500 klassifiseres som en generisk drive_error_<status> - IKKE en stille suksess", async () => {
    queue.push(jsonResponse(500, {}));
    const transport = new GoogleDriveTransport();
    await expect(transport.invoke("list_files", {}, "refresh-token")).rejects.toThrow("drive_error_500");
  });

  it("delete_permanent på en fil som allerede er borte (404) er et IDEMPOTENT vellykket utfall, ikke en feil", async () => {
    queue.push(jsonResponse(404, {}));
    const transport = new GoogleDriveTransport();
    const result = await transport.invoke("delete_permanent", { file_id: "already-gone" }, "refresh-token");
    expect(result.data).toMatchObject({ already_deleted: "true" });
  });

  it("delete_permanent på en fil som faktisk finnes returnerer already_deleted=false", async () => {
    queue.push(new Response(null, { status: 204 }));
    const transport = new GoogleDriveTransport();
    const result = await transport.invoke("delete_permanent", { file_id: "f1" }, "refresh-token");
    expect(result.data).toMatchObject({ already_deleted: "false" });
  });
});

/**
 * P1A RUNTIME WIRING CLOSEOUT (2026-08-16) §9 C/D/H: ren env-basert
 * credential-tilstedeværelse-sjekk brukt av api/main.ts og worker-main.ts
 * for å avgjøre om Drive skal registreres i den normale runtime-en. INGEN
 * nettverk/fetch her - kun `process.env`-lesing, samme presedens som resten
 * av denne fila sin "ingen live-credential nødvendig"-tilnærming.
 */
describe("googleDriveCredentialsConfigured / driveTransportsIfConfigured (P1A runtime wiring closeout §9 C/D/H)", () => {
  const KEYS = ["JARVIS_GOOGLE_CLIENT_ID", "JARVIS_GOOGLE_CLIENT_SECRET", "JARVIS_GOOGLE_TOKEN"] as const;
  const originalValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  });

  it("C: alle tre credentials mangler -> false, driveTransportsIfConfigured() returnerer et TOMT objekt (ingen 'drive'-nøkkel)", () => {
    expect(googleDriveCredentialsConfigured()).toBe(false);
    expect(driveTransportsIfConfigured()).toEqual({});
  });

  it("delvis konfigurert (KUN client_id+secret, IKKE token) -> fortsatt false - ALLE tre kreves", () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "secret";
    expect(googleDriveCredentialsConfigured()).toBe(false);
    expect(driveTransportsIfConfigured()).toEqual({});
  });

  it("A/B: alle tre credentials satt -> true, driveTransportsIfConfigured() returnerer { drive: en GoogleDriveTransport-instans }", () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "secret";
    process.env["JARVIS_GOOGLE_TOKEN"] = "token";
    expect(googleDriveCredentialsConfigured()).toBe(true);
    const transports = driveTransportsIfConfigured();
    expect(transports["drive"]).toBeInstanceOf(GoogleDriveTransport);
    expect(Object.keys(transports)).toEqual(["drive"]);
  });

  it("JARVIS_GOOGLE_OAUTH_CLIENT_TYPE (reauth-scriptets egen bokføringsmarkør) påvirker ALDRI dette resultatet - kun de tre runtime-credentialene teller", () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "secret";
    process.env["JARVIS_GOOGLE_TOKEN"] = "token";
    const before = googleDriveCredentialsConfigured();
    process.env["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"] = "desktop";
    expect(googleDriveCredentialsConfigured()).toBe(before);
    delete process.env["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"];
  });

  it("H: ingen credential-VERDI kan noensinne lekke fra disse funksjonene - returtypene er henholdsvis boolean og et objekt av transport-instanser, aldri en streng", () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "super-secret-client-id-should-never-appear";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "super-secret-client-secret-should-never-appear";
    process.env["JARVIS_GOOGLE_TOKEN"] = "super-secret-token-should-never-appear";
    const result = googleDriveCredentialsConfigured();
    expect(typeof result).toBe("boolean");
    const transports = driveTransportsIfConfigured();
    expect(JSON.stringify(Object.keys(transports))).not.toContain("super-secret");
  });
});
