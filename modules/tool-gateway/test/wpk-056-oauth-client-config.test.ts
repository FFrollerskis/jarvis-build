import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccessTokenCache, CONNECTOR_REGISTRY, SpotifyTransport, configureGoogleOAuthClientSource, createVaultFirstConfigReader, driveTransportsIfConfigured, googleAccessToken,
  googleDriveCredentialsConfigured, invalidateAllAccessTokenCaches, listConnectorStatus, primeGoogleDriveCredentialCheck, resetGoogleAccessTokenCache
} from "../src/index.ts";

/**
 * WP-K (D-471, JARVIS-056): Google-/Spotify-klientens id/secret leses via hvelvet FØRST (dashbord-lagret/Infisical) med miljøet som en LOGGET-DEPRECATED fallback. Beviser (1) rekkefølgen og at
 * fallbacken logges uten å lekke verdier, (2) at token-utvekslingen faktisk bruker hvelvets klient, (3) at Drive-registreringssjekken ser hvelvet, (4) at standardoppførselen (ingen kilde koblet inn)
 * er den gamle, stille miljølesingen, og (5) at klient-referansene kan lagres fra dashbordet uten at `configured` endres. Alle verdier er åpenbart falske.
 *
 * Review M3 (a-d): (a) en hvelvFEIL skilles fra «finnes ikke» (egen strupet logglinje, sist kjente hvelvverdi foretrekkes fremfor en utdatert .env-verdi), (b) klient-id og -secret leses parallelt med kort
 * frist, (c) Drive-registreringen venter på et hvelv som kommer opp etter api, (d) access-token-cachen nullstilles når eieren bytter en credential.
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
const errorLines = (log: Array<Record<string, string>>) => log.filter((l) => l["msg"] === "credential_vault_error");
const sourceLines = (log: Array<Record<string, string>>) => log.filter((l) => l["msg"] === "credential_source");

describe("createVaultFirstConfigReader: hvelv først, miljø som logget-deprecated fallback", () => {
  it("hvelvet vinner over miljøet: ingen fallback-/feillogg, kun ÉN `credential_source`-linje (source=vault, kun referansen) første gang - så et deploy som snur forrangen er synlig", async () => {
    const log: Array<Record<string, string>> = [];
    const read = createVaultFirstConfigReader({ vault: vaultOf({ REF_A: "fra-hvelvet" }), env: { REF_A: "fra-miljoet" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBe("fra-hvelvet");
    expect(await read("REF_A")).toBe("fra-hvelvet");
    expect(read.lastSource("REF_A")).toBe("vault");
    expect(log).toEqual([{ msg: "credential_source", ref: "REF_A", source: "vault" }]);
    expect(JSON.stringify(log)).not.toContain("fra-hvelvet");
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

  it("hvelv som kaster = «kunne ikke leses» (IKKE «finnes ikke»): miljøet tar over og kallet feiler aldri på grunn av hvelvet - men det logges som credential_vault_error, ikke som deprecated-fallback", async () => {
    const log: Array<Record<string, string>> = [];
    const down = { get: async (): Promise<string | null> => { throw new Error("infisical nede"); } };
    const read = createVaultFirstConfigReader({ vault: down, env: { REF_A: "env-a" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBe("env-a");
    expect(read.vaultState()).toBe("error");
    expect(read.lastSource("REF_A")).toBe("env");
    expect(deprecationLines(log)).toEqual([]);
    expect(errorLines(log)).toEqual([{ msg: "credential_vault_error", ref: "REF_A", reason: "exception", using: "env", action: expect.any(String) }]);
  });

  it("hvelv som returnerer tom streng = «finnes ikke» (D-236): miljøet tar over og fallbacken logges som deprecated (ikke som hvelvfeil)", async () => {
    const log: Array<Record<string, string>> = [];
    const empty = { get: async (): Promise<string | null> => "" };
    const read = createVaultFirstConfigReader({ vault: empty, env: { REF_A: "env-a" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBe("env-a");
    expect(read.vaultState()).toBe("ok");
    expect(deprecationLines(log)).toHaveLength(1);
    expect(errorLines(log)).toEqual([]);
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

describe("review M3a: «hvelvet kunne ikke leses» er ikke det samme som «verdien finnes ikke i hvelvet»", () => {
  const down = { get: async (): Promise<string | null> => { throw new Error("infisical nede"); } };

  it("en Infisical-lignende kilde som svarer null med health=unavailable behandles som FEIL (reason=unavailable), og teksten sier IKKE at verdien skal flyttes til dashbordet", async () => {
    const log: Array<Record<string, string>> = [];
    const vault = { health: "unavailable" as const, get: async (): Promise<string | null> => null };
    const read = createVaultFirstConfigReader({ vault, env: { REF_A: "env-a" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBe("env-a");
    const [line] = errorLines(log);
    expect(line).toMatchObject({ ref: "REF_A", reason: "unavailable", using: "env" });
    expect(line!["action"]).toContain("ikke flytt");
    expect(line!["action"]).not.toContain("dashbordet (Tilkoblinger)");
    expect(deprecationLines(log)).toEqual([]);
  });

  it("health=healthy med null = «finnes ikke» (deprecated, vault=absent); health=unconfigured = hvelvet er ikke i bruk (deprecated, vault=unconfigured, med tekst om at Infisical ikke er konfigurert)", async () => {
    const absentLog: Array<Record<string, string>> = [];
    const absent = createVaultFirstConfigReader({ vault: { health: "healthy", get: async () => null }, env: { REF_A: "x" }, log: (l) => absentLog.push(l) });
    expect(await absent("REF_A")).toBe("x");
    expect(absent.vaultState()).toBe("ok");
    expect(deprecationLines(absentLog)).toMatchObject([{ ref: "REF_A", source: "env", vault: "absent" }]);
    expect(errorLines(absentLog)).toEqual([]);

    const offLog: Array<Record<string, string>> = [];
    const off = createVaultFirstConfigReader({ vault: { health: "unconfigured", get: async () => null }, env: { REF_A: "x" }, log: (l) => offLog.push(l) });
    expect(await off("REF_A")).toBe("x");
    expect(off.vaultState()).toBe("ok");
    expect(deprecationLines(offLog)).toMatchObject([{ ref: "REF_A", vault: "unconfigured" }]);
    expect(deprecationLines(offLog)[0]!["action"]).toContain("Infisical) er ikke konfigurert");
    expect(errorLines(offLog)).toEqual([]);
  });

  it("feillinjen er strupet per referanse: et vedvarende avbrudd synes uten å fylle loggen, og logges på nytt når intervallet er over", async () => {
    const log: Array<Record<string, string>> = [];
    let clock = 1_000_000;
    const read = createVaultFirstConfigReader({ vault: down, env: { REF_A: "a", REF_B: "b" }, log: (l) => log.push(l), errorLogIntervalMs: 60_000, now: () => clock });
    await read("REF_A"); await read("REF_A"); await read("REF_B");
    expect(errorLines(log).map((l) => l["ref"])).toEqual(["REF_A", "REF_B"]);
    clock += 59_999;
    await read("REF_A");
    expect(errorLines(log)).toHaveLength(2);
    clock += 1;
    await read("REF_A");
    expect(errorLines(log).map((l) => l["ref"])).toEqual(["REF_A", "REF_B", "REF_A"]);
  });

  it("den SIST KJENTE hvelvverdien brukes når hvelvet svikter (en rotert hemmelighet byttes ikke ut med en utdatert .env-verdi); kilden logges ved hvert skifte, aldri verdien", async () => {
    const log: Array<Record<string, string>> = [];
    const mode: { value: "ok" | "down" | "absent" } = { value: "ok" };
    const vault = { get: async (): Promise<string | null> => { if (mode.value === "down") throw new Error("nede"); return mode.value === "absent" ? null : "vault-verdi-v1"; } };
    const read = createVaultFirstConfigReader({ vault, env: { REF_A: "gammel-env-verdi" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBe("vault-verdi-v1");
    mode.value = "down";
    expect(await read("REF_A")).toBe("vault-verdi-v1"); // IKKE gammel-env-verdi
    expect(read.lastSource("REF_A")).toBe("vault_last_known");
    expect(errorLines(log)[0]).toMatchObject({ ref: "REF_A", using: "last_known_vault_value" });
    mode.value = "ok";
    expect(await read("REF_A")).toBe("vault-verdi-v1");
    expect(read.lastSource("REF_A")).toBe("vault");
    expect(read.vaultState()).toBe("ok");
    expect(sourceLines(log).map((l) => l["source"])).toEqual(["vault", "vault_last_known", "vault"]);
    expect(deprecationLines(log)).toEqual([]);
    // hvelvet SVARER «finnes ikke» (ikke en feil): den sist kjente verdien gjelder ikke lenger, miljøet brukes og fallbacken logges
    mode.value = "absent";
    expect(await read("REF_A")).toBe("gammel-env-verdi");
    expect(deprecationLines(log)).toMatchObject([{ ref: "REF_A", vault: "absent" }]);
    const everything = JSON.stringify(log);
    expect(everything).not.toContain("vault-verdi-v1");
    expect(everything).not.toContain("gammel-env-verdi");
  });

  it("re-review LOW 3: en verdi som ble SLETTET fra hvelvet (rollback, runbook §10) kommer ikke tilbake som «sist kjent» når hvelvet senere får et avbrudd i samme prosess - miljøet gjelder", async () => {
    const log: Array<Record<string, string>> = [];
    const mode: { value: "ok" | "down" | "absent" } = { value: "ok" };
    const vault = { get: async (): Promise<string | null> => { if (mode.value === "down") throw new Error("nede"); return mode.value === "absent" ? null : "vault-verdi-v1"; } };
    const read = createVaultFirstConfigReader({ vault, env: { REF_A: "env-verdi" }, log: (l) => log.push(l) });
    expect(await read("REF_A")).toBe("vault-verdi-v1");
    mode.value = "absent"; // eieren sletter hvelvoppføringen
    expect(await read("REF_A")).toBe("env-verdi");
    mode.value = "down"; // hvelvet får et avbrudd i samme prosess
    expect(await read("REF_A")).toBe("env-verdi"); // IKKE den slettede vault-verdien-v1
    expect(read.lastSource("REF_A")).toBe("env");
    expect(read.vaultState()).toBe("error");
    expect(errorLines(log)).toHaveLength(1);
    expect(errorLines(log)[0]).toMatchObject({ ref: "REF_A", reason: "exception", using: "env" });
    // Hvelvet er tilbake med en NY verdi: den gjelder, og blir den nye sist kjente.
    mode.value = "ok";
    expect(await read("REF_A")).toBe("vault-verdi-v1");
    mode.value = "down";
    expect(await read("REF_A")).toBe("vault-verdi-v1");
    expect(read.lastSource("REF_A")).toBe("vault_last_known");
    expect(JSON.stringify(log)).not.toContain("vault-verdi-v1");
    expect(JSON.stringify(log)).not.toContain("env-verdi");
  });

  it("re-review LOW 3: samme når hvelvet slutter å være konfigurert (health=unconfigured) - den sist kjente verdien nullstilles, og er per referanse (en annen referanse beholder sin)", async () => {
    const state: { health: "healthy" | "unconfigured" | "unavailable"; down: boolean } = { health: "healthy", down: false };
    const values: Record<string, string> = { REF_A: "vault-a", REF_B: "vault-b" };
    const vault = {
      get health() { return state.health; },
      get: async (ref: string): Promise<string | null> => {
        if (state.down) { state.health = "unavailable"; return null; }
        if (state.health === "unconfigured") return null;
        return values[ref] ?? null;
      }
    };
    const read = createVaultFirstConfigReader({ vault, env: { REF_A: "env-a", REF_B: "env-b" }, log: () => undefined });
    expect(await read("REF_A")).toBe("vault-a");
    expect(await read("REF_B")).toBe("vault-b");
    state.health = "unconfigured"; // Infisical er ikke lenger konfigurert (get() gir null og health=unconfigured)
    expect(await read("REF_A")).toBe("env-a");
    state.health = "healthy";
    state.down = true; // avbrudd: REF_A har ikke lenger en sist kjent verdi, REF_B har
    expect(await read("REF_A")).toBe("env-a");
    expect(await read("REF_B")).toBe("vault-b");
    expect(read.lastSource("REF_A")).toBe("env");
    expect(read.lastSource("REF_B")).toBe("vault_last_known");
  });

  it("vaultState() er «error» når NOEN referanse feilet sist, og «ok» når alle siste oppslag svarte", async () => {
    const mode: { value: "ok" | "down" } = { value: "down" };
    const vault = { get: async (ref: string): Promise<string | null> => { if (mode.value === "down" && ref === "REF_A") throw new Error("nede"); return null; } };
    const read = createVaultFirstConfigReader({ vault, env: {}, log: () => undefined });
    await read("REF_B");
    expect(read.vaultState()).toBe("ok");
    await read("REF_A");
    expect(read.vaultState()).toBe("error");
    mode.value = "ok";
    await read("REF_A");
    expect(read.vaultState()).toBe("ok");
  });
});

describe("review M3b: klient-id og -secret leses PARALLELT, og et hengt hvelv har en kort frist", () => {
  it("et HENGT hvelv gir feil etter fristen (reason=timeout, ikke evig ventetid): miljøet brukes og kallet fullføres", async () => {
    const log: Array<Record<string, string>> = [];
    const hung = { get: (): Promise<string | null> => new Promise(() => undefined) };
    const started = Date.now();
    const read = createVaultFirstConfigReader({ vault: hung, env: { REF_A: "env-a" }, log: (l) => log.push(l), timeoutMs: 60 });
    expect(await read("REF_A")).toBe("env-a");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(errorLines(log)[0]).toMatchObject({ reason: "timeout", using: "env" });
  });

  it("token-utvekslingen starter BEGGE hvelvoppslagene før noen av dem er besvart (ikke to sekvensielle ventetider)", async () => {
    const started: string[] = [];
    const resolvers = new Map<string, (value: string | null) => void>();
    const vault = { get: (ref: string): Promise<string | null> => new Promise((resolve) => { started.push(ref); resolvers.set(ref, resolve); }) };
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault, log: () => undefined }));
    const pending = googleAccessToken("fake-refresh-token");
    await new Promise((resolve) => setTimeout(resolve, 0)); // tøm mikrokøen: ingen av oppslagene er besvart ennå
    expect([...started].sort()).toEqual(["JARVIS_GOOGLE_CLIENT_ID", "JARVIS_GOOGLE_CLIENT_SECRET"]);
    resolvers.get("JARVIS_GOOGLE_CLIENT_ID")!("vault-id");
    resolvers.get("JARVIS_GOOGLE_CLIENT_SECRET")!("vault-secret");
    await expect(pending).resolves.toBe("fake-access-token");
    const body = new URLSearchParams(tokenBodies[0]);
    expect([body.get("client_id"), body.get("client_secret")]).toEqual(["vault-id", "vault-secret"]);
  });

  it("token-utveksling mot et hengt hvelv med miljøverdier: fullfører med miljøverdiene innen fristen (ikke 5-10 s)", async () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "env-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "env-client-secret";
    const hung = { get: (): Promise<string | null> => new Promise(() => undefined) };
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: hung, log: () => undefined, timeoutMs: 80 }));
    const started = Date.now();
    await expect(googleAccessToken("fake-refresh-token")).resolves.toBe("fake-access-token");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(new URLSearchParams(tokenBodies[0]).get("client_id")).toBe("env-client-id");
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

describe("review M3c: Drive-registreringen tåler et hvelv som kommer opp etter api", () => {
  const readToken = (values: Record<string, string>) => async (ref: string) => values[ref] ?? null;
  const VALUES: Record<string, string> = { JARVIS_GOOGLE_CLIENT_ID: "vault-id", JARVIS_GOOGLE_CLIENT_SECRET: "vault-secret" };

  it("hvelvet er nede ved oppstart men kommer opp innen vinduet: målingen gjentas og Drive registreres (tidligere stille utelatt til neste omstart)", async () => {
    const state = { up: false };
    const vault = { get: async (ref: string): Promise<string | null> => { if (!state.up) throw new Error("infisical starter ennå"); return VALUES[ref] ?? null; } };
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault, log: () => undefined }));
    const log: Array<Record<string, string>> = [];
    let sleeps = 0;
    const ok = await primeGoogleDriveCredentialCheck(readToken({ JARVIS_GOOGLE_TOKEN: "fake-refresh-token" }), {
      attempts: 5, delayMs: 1, log: (l) => log.push(l), sleep: async () => { sleeps += 1; if (sleeps >= 2) state.up = true; }
    });
    expect(ok).toBe(true);
    expect(sleeps).toBe(2);
    expect(log.map((l) => l["msg"])).toEqual(["drive_registration_waiting_for_vault", "drive_registration_waiting_for_vault"]);
    expect(Object.keys(driveTransportsIfConfigured())).toEqual(["drive"]);
  });

  it("hvelvet kommer aldri opp: etter `attempts` målinger er svaret endelig false, og én tydelig linje sier at Drive IKKE er registrert fordi hvelvet var nede", async () => {
    const vault = { get: async (): Promise<string | null> => { throw new Error("nede"); } };
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault, log: () => undefined }));
    const log: Array<Record<string, string>> = [];
    let sleeps = 0;
    const ok = await primeGoogleDriveCredentialCheck(readToken({ JARVIS_GOOGLE_TOKEN: "fake-refresh-token" }), {
      attempts: 3, delayMs: 1, log: (l) => log.push(l), sleep: async () => { sleeps += 1; }
    });
    expect(ok).toBe(false);
    expect(sleeps).toBe(2);
    expect(log.map((l) => l["msg"])).toEqual(["drive_registration_waiting_for_vault", "drive_registration_waiting_for_vault", "drive_registration_skipped_vault_unavailable"]);
    expect(log.at(-1)).toMatchObject({ attempts: "3" });
    expect(log.at(-1)!["action"]).toContain("Start api og worker på nytt");
    expect(driveTransportsIfConfigured()).toEqual({});
  });

  it("hvelvet SVARER «finnes ikke»: første måling er endelig - ingen ventetid, ingen retry, ingen logg", async () => {
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: { health: "healthy", get: async () => null }, log: () => undefined }));
    const log: Array<Record<string, string>> = [];
    let sleeps = 0;
    const ok = await primeGoogleDriveCredentialCheck(readToken({ JARVIS_GOOGLE_TOKEN: "fake-refresh-token" }), { attempts: 5, log: (l) => log.push(l), sleep: async () => { sleeps += 1; } });
    expect(ok).toBe(false);
    expect(sleeps).toBe(0);
    expect(log).toEqual([]);
  });

  it("en Infisical-lignende kilde med health=unavailable (null, ikke kast) regnes også som «hvelvet svarte ikke» og gir nye målinger", async () => {
    const state = { up: false };
    const vault = {
      get health(): "healthy" | "unavailable" { return state.up ? "healthy" : "unavailable"; },
      get: async (ref: string): Promise<string | null> => (state.up ? VALUES[ref] ?? null : null)
    };
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault, log: () => undefined }));
    let sleeps = 0;
    const ok = await primeGoogleDriveCredentialCheck(readToken({ JARVIS_GOOGLE_TOKEN: "fake-refresh-token" }), {
      attempts: 4, delayMs: 1, log: () => undefined, sleep: async () => { sleeps += 1; state.up = true; }
    });
    expect(ok).toBe(true);
    expect(sleeps).toBe(1);
  });

  it("verdiene finnes i miljøet mens hvelvet er nede: konfigurert på første måling (ingen ventetid)", async () => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "env-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "env-secret";
    configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: { get: async () => { throw new Error("nede"); } }, log: () => undefined }));
    let sleeps = 0;
    const ok = await primeGoogleDriveCredentialCheck(readToken({ JARVIS_GOOGLE_TOKEN: "fake-refresh-token" }), { attempts: 5, log: () => undefined, sleep: async () => { sleeps += 1; } });
    expect(ok).toBe(true);
    expect(sleeps).toBe(0);
  });

  it("en kilde uten vaultState() (en rå ConfigReader) og ingen kilde i det hele tatt: én måling, aldri retry", async () => {
    let sleeps = 0;
    const options = { attempts: 5, log: () => undefined, sleep: async () => { sleeps += 1; } };
    configureGoogleOAuthClientSource(async () => null);
    expect(await primeGoogleDriveCredentialCheck(readToken({}), options)).toBe(false);
    configureGoogleOAuthClientSource(undefined);
    expect(await primeGoogleDriveCredentialCheck(readToken({}), options)).toBe(false);
    expect(sleeps).toBe(0);
  });

  it("standard: 7 målinger med 5 s mellomrom (ca. 30 s totalt), mellomrommet bruker ekte (her falske) timere", async () => {
    vi.useFakeTimers();
    try {
      configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: { get: async () => { throw new Error("nede"); } }, log: () => undefined }));
      const log: Array<Record<string, string>> = [];
      let settled = false;
      const done = primeGoogleDriveCredentialCheck(readToken({ JARVIS_GOOGLE_TOKEN: "fake-refresh-token" }), { log: (l) => log.push(l) }).then((v) => { settled = true; return v; });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      expect(log.filter((l) => l["msg"] === "drive_registration_waiting_for_vault")).toHaveLength(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(await done).toBe(false);
      expect(log.at(-1)!["msg"]).toBe("drive_registration_skipped_vault_unavailable");
      expect(log.at(-1)!["attempts"]).toBe("7");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("review M3d: access-token-cachen nullstilles når eieren bytter en credential", () => {
  const counting = (): { exchanges: () => number; cache: AccessTokenCache; persisted: string[] } => {
    let n = 0;
    const persisted: string[] = [];
    const cache = new AccessTokenCache({ exchange: async () => { n += 1; return { access_token: `fake-access-${n}`, expires_in: 3600 }; } }, { persist: async (t) => { persisted.push(t); } });
    return { exchanges: () => n, cache, persisted };
  };

  it("clear() glemmer cachede tokens: neste get() gjør en fersk utveksling", async () => {
    const { cache, exchanges } = counting();
    expect(await cache.get("fake-refresh")).toBe("fake-access-1");
    expect(await cache.get("fake-refresh")).toBe("fake-access-1");
    expect(exchanges()).toBe(1);
    cache.clear();
    expect(await cache.get("fake-refresh")).toBe("fake-access-2");
    expect(exchanges()).toBe(2);
  });

  it("invalidateAllAccessTokenCaches() nullstiller ALLE levende cacher i prosessen (også den delte Google-cachen)", async () => {
    const a = counting();
    const b = counting();
    await a.cache.get("rt");
    await b.cache.get("rt");
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "env-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "env-client-secret";
    await googleAccessToken("fake-refresh-token");
    await googleAccessToken("fake-refresh-token");
    expect(tokenBodies).toHaveLength(1);
    expect(invalidateAllAccessTokenCaches()).toBeGreaterThanOrEqual(3);
    expect(await a.cache.get("rt")).toBe("fake-access-2");
    expect(await b.cache.get("rt")).toBe("fake-access-2");
    await googleAccessToken("fake-refresh-token");
    expect(tokenBodies).toHaveLength(2);
  });

  it("en utveksling som PÅGÅR når cachen nullstilles caches ikke og persisteres ikke (utstedt med gammel konfig), en ny get() starter en fersk utveksling, og den gamle fullføringen river ikke den nye pågående", async () => {
    const calls: Array<{ resolve: (token: { access_token: string; expires_in: number; refresh_token?: string }) => void }> = [];
    const persisted: string[] = [];
    const cache = new AccessTokenCache({
      exchange: () => new Promise((resolve) => { calls.push({ resolve }); })
    }, { persist: async (t) => { persisted.push(t); } });
    const first = cache.get("rt");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    cache.clear();
    const second = cache.get("rt");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(2); // ikke delt med den gamle utvekslingen
    calls[0]!.resolve({ access_token: "fake-old-access", expires_in: 3600, refresh_token: "fake-rotated-old" });
    expect(await first).toBe("fake-old-access"); // gyldig for den gamle kalleren
    expect(persisted).toEqual([]);
    const third = cache.get("rt"); // den nye utvekslingen er fortsatt pågående og deles - IKKE revet av den gamle finally
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ access_token: "fake-new-access", expires_in: 3600 });
    expect(await second).toBe("fake-new-access");
    expect(await third).toBe("fake-new-access");
    expect(await cache.get("rt")).toBe("fake-new-access"); // cachet: ingen tredje utveksling
    expect(calls).toHaveLength(2);
  });

  it("uten nullstilling er rotasjon uendret: nytt refresh-token persisteres og caches under den nye nøkkelen", async () => {
    const persisted: string[] = [];
    let n = 0;
    const cache = new AccessTokenCache({ exchange: async () => { n += 1; return { access_token: "fake-access", expires_in: 3600, refresh_token: "fake-rotated" }; } }, { persist: async (t) => { persisted.push(t); } });
    expect(await cache.get("rt")).toBe("fake-access");
    expect(persisted).toEqual(["fake-rotated"]);
    expect(await cache.get("fake-rotated")).toBe("fake-access");
    expect(n).toBe(1);
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
