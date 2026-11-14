import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_REGISTRY, SpotifyTransport, configureGoogleOAuthClientSource, createVaultFirstConfigReader, driveTransportsIfConfigured, googleAccessToken,
  googleDriveCredentialsConfigured, listConnectorStatus, primeGoogleDriveCredentialCheck, resetGoogleAccessTokenCache
} from "../src/index.ts";

/**
 * WP-K (D-471, JARVIS-056): Google-/Spotify-klientens id/secret leses via hvelvet FØRST (dashbord-lagret/Infisical) med miljøet som en LOGGET-DEPRECATED fallback. Beviser (1) rekkefølgen og at
 * fallbacken logges uten å lekke verdier, (2) at token-utvekslingen faktisk bruker hvelvets klient, (3) at Drive-registreringssjekken ser hvelvet, (4) at standardoppførselen (ingen kilde koblet inn)
 * er den gamle, stille miljølesingen, og (5) at klient-referansene kan lagres fra dashbordet uten at `configured` endres. Alle verdier er åpenbart falske.
 */
const originalFetch = global.fetch;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ENV_KEYS = ["JARVIS_GOOGLE_CLIENT_ID", "JARVIS_GOOGLE_CLIENT_SECRET", "JARVIS_GOOGLE_TOKEN", "JARVIS_SPOTIFY_CLIENT_ID", "JARVIS_SPOTIFY_CLIENT_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

let tokenBodies: string[];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  tokenBodies = [];
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  configureGoogleOAuthClientSource(undefined);
  resetGoogleAccessTokenCache();
  global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      tokenBodies.push(String(init?.body));
      return json(200, { access_token: "fake-access-token", expires_in: 3600 });
    }
    if (url.startsWith("https://accounts.spotify.com/api/token")) {
      tokenBodies.push(`${String((init?.headers as Record<string, string> | undefined)?.["authorization"] ?? "")}|${String(init?.body)}`);
      return json(200, { access_token: "fake-spotify-access", expires_in: 3600 });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]!; }
  configureGoogleOAuthClientSource(undefined);
  resetGoogleAccessTokenCache();
  vi.restoreAllMocks();
});

const vaultOf = (values: Record<string, string>) => ({ get: async (ref: string) => values[ref] ?? null });
const deprecationLines = (log: Array<Record<string, string>>) => log.filter((l) => l["msg"] === "credential_env_fallback_deprecated");

describe("createVaultFirstConfigReader: hvelv først, miljø som logget-deprecated fallback", () => {
  it("hvelvet vinner over miljøet, og da logges ingenting (ikke en fallback)", async () => {
    const log: Array<Record<string, string>> = [];
    const read = createVaultFirstConfigReader({ vault: vaultOf({ REF_A: "fra-hvelvet" }), env: { REF_A: "fra-miljoet" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBe("fra-hvelvet");
    expect(read.lastSource("REF_A")).toBe("vault");
    expect(log).toEqual([]);
  });

  it("miljøfallbacken virker uendret (verdien returneres) og logges ÉN gang per referanse - kun referansenavnet, aldri verdien", async () => {
    const log: Array<Record<string, string>> = [];
    const read = createVaultFirstConfigReader({ vault: vaultOf({}), env: { REF_A: "hemmelig-verdi-skal-aldri-logges", REF_B: "annen-verdi" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBe("hemmelig-verdi-skal-aldri-logges");
    expect(await read("REF_A")).toBe("hemmelig-verdi-skal-aldri-logges");
    expect(await read("REF_B")).toBe("annen-verdi");
    expect(read.lastSource("REF_A")).toBe("env");
    const lines = deprecationLines(log);
    expect(lines.map((l) => l["ref"])).toEqual(["REF_A", "REF_B"]);
    expect(JSON.stringify(log)).not.toContain("hemmelig-verdi");
    expect(JSON.stringify(log)).not.toContain("annen-verdi");
  });

  it("hvelv som kaster eller returnerer tom streng behandles som «ikke tilgjengelig» - miljøet tar over, kallet feiler aldri på grunn av hvelvet", async () => {
    const log: Array<Record<string, string>> = [];
    const down = { get: async (): Promise<string | null> => { throw new Error("infisical nede"); } };
    expect(await createVaultFirstConfigReader({ vault: down, env: { REF_A: "env-a" }, log: (l) => log.push(l) })("REF_A")).toBe("env-a");
    const empty = { get: async (): Promise<string | null> => "" };
    expect(await createVaultFirstConfigReader({ vault: empty, env: { REF_A: "env-a" }, log: (l) => log.push(l) })("REF_A")).toBe("env-a");
    expect(deprecationLines(log)).toHaveLength(2); // hver leser har sin egen «én gang»-sperre
  });

  it("verken hvelv eller miljø: null (og tom miljøvariabel = ikke satt, D-236), uten logg", async () => {
    const log: Array<Record<string, string>> = [];
    const read = createVaultFirstConfigReader({ vault: vaultOf({}), env: { REF_A: "" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBeNull();
    expect(await read("REF_MISSING")).toBeNull();
    expect(read.lastSource("REF_A")).toBe("missing");
    expect(log).toEqual([]);
  });

  it("uten hvelv (`vault` utelatt) er det miljøet alene - fortsatt logget som deprecated", async () => {
    const log: Array<Record<string, string>> = [];
    const read = createVaultFirstConfigReader({ env: { REF_A: "x" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBe("x");
    expect(deprecationLines(log)).toHaveLength(1);
  });
});

describe("Google: token-utvekslingen bruker hvelvets klient når en kilde er koblet inn", () => {
  it("hvelvets client id/secret brukes (ikke miljøets), uten deprecation-logg", async () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "env-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "env-client-secret";
    const log: Array<Record<string, string>> = [];
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({
      vault: vaultOf({ JARVIS_GOOGLE_CLIENT_ID: "vault-client-id", JARVIS_GOOGLE_CLIENT_SECRET: "vault-client-secret" }), log: (l) => log.push(l)
    }));
    expect(await googleAccessToken("fake-refresh-token")).toBe("fake-access-token");
    expect(tokenBodies).toHaveLength(1);
    const body = new URLSearchParams(tokenBodies[0]);
    expect(body.get("client_id")).toBe("vault-client-id");
    expect(body.get("client_secret")).toBe("vault-client-secret");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(deprecationLines(log)).toEqual([]);
  });

  it("hvelvet tomt: dagens miljøkonfig virker uendret, og fallbacken er logget som deprecated (én linje per ref, selv etter flere utvekslinger)", async () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "env-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "env-client-secret";
    const log: Array<Record<string, string>> = [];
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: vaultOf({}), log: (l) => log.push(l) }));
    await googleAccessToken("fake-refresh-token");
    resetGoogleAccessTokenCache();
    await googleAccessToken("fake-refresh-token");
    expect(tokenBodies).toHaveLength(2);
    for (const raw of tokenBodies) {
      const body = new URLSearchParams(raw);
      expect([body.get("client_id"), body.get("client_secret")]).toEqual(["env-client-id", "env-client-secret"]);
    }
    expect(deprecationLines(log).map((l) => l["ref"])).toEqual(["JARVIS_GOOGLE_CLIENT_ID", "JARVIS_GOOGLE_CLIENT_SECRET"]);
    expect(JSON.stringify(log)).not.toContain("env-client");
  });

  it("verken hvelv eller miljø: google_oauth_client_not_configured, ingen nettverkskall", async () => {
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: vaultOf({}), env: {}, log: () => undefined }));
    await expect(googleAccessToken("fake-refresh-token")).rejects.toThrow("google_oauth_client_not_configured");
    expect(tokenBodies).toEqual([]);
  });

  it("STANDARD (ingen kilde koblet inn - skript/tester): miljøet leses stille som før, og logger ingenting", async () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "env-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "env-client-secret";
    await googleAccessToken("fake-refresh-token");
    const body = new URLSearchParams(tokenBodies[0]);
    expect([body.get("client_id"), body.get("client_secret")]).toEqual(["env-client-id", "env-client-secret"]);
    expect(warn).not.toHaveBeenCalled();
    delete process.env["JARVIS_GOOGLE_CLIENT_SECRET"];
    resetGoogleAccessTokenCache();
    await expect(googleAccessToken("fake-refresh-token")).rejects.toThrow("google_oauth_client_not_configured");
  });

  it("å bytte kilde nullstiller access-token-cachen: et token utvekslet med en annen klient gjenbrukes aldri", async () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "env-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "env-client-secret";
    await googleAccessToken("fake-refresh-token");
    await googleAccessToken("fake-refresh-token");
    expect(tokenBodies).toHaveLength(1); // cachet
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: vaultOf({ JARVIS_GOOGLE_CLIENT_ID: "vault-id", JARVIS_GOOGLE_CLIENT_SECRET: "vault-secret" }), log: () => undefined }));
    await googleAccessToken("fake-refresh-token");
    expect(tokenBodies).toHaveLength(2);
    expect(new URLSearchParams(tokenBodies[1]).get("client_id")).toBe("vault-id");
  });
});

describe("Drive-registreringssjekken ser hvelvet (ikke bare miljøet)", () => {
  const readToken = (values: Record<string, string>) => async (ref: string) => values[ref] ?? null;

  it("STANDARD uten priming: den uendrede miljøsjekken (alle tre må være satt)", () => {
    expect(googleDriveCredentialsConfigured()).toBe(false);
    expect(driveTransportsIfConfigured()).toEqual({});
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "secret";
    expect(googleDriveCredentialsConfigured()).toBe(false); // token mangler
    process.env["JARVIS_GOOGLE_TOKEN"] = "fake-refresh-token";
    expect(googleDriveCredentialsConfigured()).toBe(true);
    expect(Object.keys(driveTransportsIfConfigured())).toEqual(["drive"]);
  });

  it("hvelv-lagret konfig (ingenting i miljøet): primet sjekk gir true og Drive-transporten registreres - tidligere ble den aldri registrert", async () => {
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: vaultOf({ JARVIS_GOOGLE_CLIENT_ID: "vault-id", JARVIS_GOOGLE_CLIENT_SECRET: "vault-secret" }), log: () => undefined }));
    expect(await primeGoogleDriveCredentialCheck(readToken({ JARVIS_GOOGLE_TOKEN: "fake-refresh-token" }))).toBe(true);
    expect(googleDriveCredentialsConfigured()).toBe(true);
    expect(Object.keys(driveTransportsIfConfigured())).toEqual(["drive"]);
  });

  it("mangler ett av de tre (eller leseren kaster): false, aldri et kast; å koble ut kilden nullstiller målingen til miljøsjekken", async () => {
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: vaultOf({ JARVIS_GOOGLE_CLIENT_ID: "vault-id", JARVIS_GOOGLE_CLIENT_SECRET: "vault-secret" }), log: () => undefined }));
    expect(await primeGoogleDriveCredentialCheck(readToken({}))).toBe(false);
    expect(driveTransportsIfConfigured()).toEqual({});
    expect(await primeGoogleDriveCredentialCheck(async () => { throw new Error("boom"); })).toBe(false);
    configureGoogleOAuthClientSource(undefined);
    expect(googleDriveCredentialsConfigured()).toBe(false); // miljøet er tomt - snapshot er forkastet
  });
});

describe("Spotify: standardfallbacken (uten resolvere) er logget som deprecated; resolvere vinner", () => {
  const exchange = async (transport: SpotifyTransport): Promise<void> => { await transport.invoke("get_currently_playing", {}, "fake-spotify-refresh").catch(() => undefined); };

  it("uten resolvere: miljøet brukes (uendret) og logges deprecated med kun refnavn", async () => {
    process.env["JARVIS_SPOTIFY_CLIENT_ID"] = "env-spotify-id";
    process.env["JARVIS_SPOTIFY_CLIENT_SECRET"] = "env-spotify-secret";
    await exchange(new SpotifyTransport());
    const basic = Buffer.from("env-spotify-id:env-spotify-secret").toString("base64");
    expect(tokenBodies.some((t) => t.includes(basic) || t.includes("env-spotify-id"))).toBe(true);
    const logged = warn.mock.calls.map((c) => String(c[0]));
    expect(logged.filter((l) => l.includes("credential_env_fallback_deprecated")).map((l) => (JSON.parse(l) as { ref: string }).ref).sort()).toEqual(["JARVIS_SPOTIFY_CLIENT_ID", "JARVIS_SPOTIFY_CLIENT_SECRET"]);
    expect(logged.join("\n")).not.toContain("env-spotify-id");
    expect(logged.join("\n")).not.toContain("env-spotify-secret");
  });

  it("med resolvere (som api/worker gir): resolveren brukes, miljøet leses ikke, ingen deprecation-logg", async () => {
    process.env["JARVIS_SPOTIFY_CLIENT_ID"] = "env-spotify-id";
    process.env["JARVIS_SPOTIFY_CLIENT_SECRET"] = "env-spotify-secret";
    await exchange(new SpotifyTransport({ clientId: async () => "resolver-spotify-id", clientSecret: async () => "resolver-spotify-secret" }));
    const basic = Buffer.from("resolver-spotify-id:resolver-spotify-secret").toString("base64");
    expect(tokenBodies.some((t) => t.includes(basic) || t.includes("resolver-spotify-id"))).toBe(true);
    expect(tokenBodies.join("\n")).not.toContain(Buffer.from("env-spotify-id:env-spotify-secret").toString("base64"));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("credential_env_fallback_deprecated"))).toEqual([]);
  });
});

describe("dashbordet: klient-referansene kan lagres uten at connectorens `configured` endres", () => {
  it("gmail/google_calendar/google_drive/google_sheets har JARVIS_GOOGLE_CLIENT_ID/_SECRET som VALGFRIE refs (egne kopier), og de påkrevde refs er uendret", () => {
    const expected: Record<string, string[]> = {
      google_calendar: ["JARVIS_GOOGLE_TOKEN"], gmail: ["JARVIS_EMAIL_TOKEN"], google_drive: ["JARVIS_GOOGLE_TOKEN"], google_sheets: ["JARVIS_GOOGLE_SHEETS_TOKEN"]
    };
    const lists = new Set<unknown>();
    for (const [id, required] of Object.entries(expected)) {
      const def = CONNECTOR_REGISTRY.find((c) => c.id === id)!;
      expect(def.credential_refs, id).toEqual(required);
      expect(def.optional_credential_refs, id).toEqual(["JARVIS_GOOGLE_CLIENT_ID", "JARVIS_GOOGLE_CLIENT_SECRET"]);
      lists.add(def.optional_credential_refs);
    }
    expect(lists.size).toBe(4); // ingen delt, muterbar array-referanse
  });

  it("status: configured avhenger kun av de påkrevde refs; de valgfrie vises som optional_credentials", async () => {
    const present = new Set(["JARVIS_GOOGLE_TOKEN"]);
    const statuses = await listConnectorStatus({ hasSecret: async (ref: string) => present.has(ref), health: new Map() } as never, ["google_calendar"]);
    expect(statuses[0]).toMatchObject({ id: "google_calendar", configured: true });
    expect(statuses[0]!.optional_credentials).toEqual([
      { ref: "JARVIS_GOOGLE_CLIENT_ID", configured: false }, { ref: "JARVIS_GOOGLE_CLIENT_SECRET", configured: false }
    ]);
  });
});

describe("kildevakt: ingen rå miljølesing av klient-id/secret utenfor den delte leseren", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

  it("ingen kildefil i tool-gateway leser process.env[\"JARVIS_GOOGLE_CLIENT_ID|_SECRET\"] eller process.env[\"JARVIS_SPOTIFY_CLIENT_ID|_SECRET\"] direkte", () => {
    const offenders = files.filter((f) => /process\.env\[\s*"JARVIS_(GOOGLE|SPOTIFY)_CLIENT_(ID|SECRET)"\s*\]/.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
