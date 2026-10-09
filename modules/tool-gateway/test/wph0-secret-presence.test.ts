import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { PolicyGateway } from "@jarvis/policy";
import {
  EnvSecretProvider, FallbackSecretProvider, InfisicalSecretProvider, ToolGateway, secretPresenceOf,
  type SecretPresence, type SecretProvider, type SecretSourceHealth
} from "../src/gateway.ts";

/**
 * WP-H0, gjennomgang av PR #316 (M-1 + L-3): TRI-STATE presence for credential-kilder.
 *
 * Funnet: `InfisicalSecretProvider.get` svelget feil og ga null, `hasSecret` kaster aldri i drift, og dermed ble «Infisical nede» (kunne ikke måles) til «ikke konfigurert» (mangler) - med status OK i kontrollsenteret.
 * Her låses grunnlaget: presence er `present` / `absent` (en måling) / `unknown` (kilden kunne ikke spørres), utledet DETERMINISTISK (ingen delt tilstand å rase på), og aldri «absent» fra en kilde som ikke svarte.
 * L-3: samtidige oppslag deler ÉN innlogging (tidligere opptil 87 parallelle).
 */
function fakePolicy(): PolicyGateway {
  return {} as unknown as PolicyGateway;
}
function fakePool(): pg.Pool {
  return {} as unknown as pg.Pool;
}
const gatewayOver = (secrets: SecretProvider): ToolGateway => new ToolGateway(fakePool(), fakePolicy(), secrets);

/** En kilde som returnerer en gitt verdi og har en gitt helse - men INGEN egen presence() (generisk vei). */
function plain(value: string | null, health?: SecretSourceHealth): SecretProvider {
  return { name: "plain", get: async () => value, ...(health !== undefined ? { health } : {}) };
}

describe("secretPresenceOf: generisk utledning fra get() og helse", () => {
  it("en verdi er present - selv om kilden ellers er utilgjengelig", async () => {
    expect(await secretPresenceOf(plain("verdi", "unavailable"), "REF")).toBe("present");
    expect(await secretPresenceOf(plain("verdi"), "REF")).toBe("present");
  });

  it("REPRO fra gjennomgangen: en kilde som returnerer null og har health = unavailable er UKJENT - ikke fraværende", async () => {
    expect(await secretPresenceOf(plain(null, "unavailable"), "REF")).toBe("unknown");
  });

  it("null fra en frisk, ikke-konfigurert eller helseløs kilde er en MÅLING: absent", async () => {
    for (const health of ["healthy", "unconfigured", undefined] as const) {
      expect(await secretPresenceOf(plain(null, health), "REF"), String(health)).toBe("absent");
    }
  });

  it("en tom streng er aldri en gyldig credential (D-236) og regnes som fraværende, som ToolGateway.execute() gjør", async () => {
    expect(await secretPresenceOf(plain("", "healthy"), "REF")).toBe("absent");
    expect(await secretPresenceOf(plain("", "unavailable"), "REF")).toBe("unknown");
  });

  it("kildens egen presence() har forrang (ingen utledning fra get/health)", async () => {
    const own: SecretProvider = { name: "own", get: async () => "x", health: "healthy", presence: async () => "unknown" };
    expect(await secretPresenceOf(own, "REF")).toBe("unknown");
  });
});

describe("ToolGateway.secretPresence og secretsHealth", () => {
  it("true / false / null for present / absent / unknown - og hasSecret() er uendret (to-state)", async () => {
    expect(await gatewayOver(plain("v")).secretPresence("R")).toBe(true);
    expect(await gatewayOver(plain(null, "healthy")).secretPresence("R")).toBe(false);
    expect(await gatewayOver(plain(null, "unavailable")).secretPresence("R")).toBeNull();
    // hasSecret kan ikke skille «nede» fra «mangler» - derfor finnes secretPresence
    expect(await gatewayOver(plain(null, "unavailable")).hasSecret("R")).toBe(false);
  });

  it("kaster ALDRI: en kilde som kaster gir null (ukjent), ikke et unntak og ikke false", async () => {
    const boom: SecretProvider = { name: "boom", get: async () => { throw new Error("connect ECONNREFUSED 10.0.0.9"); } };
    await expect(gatewayOver(boom).secretPresence("R")).resolves.toBeNull();
    const boomPresence: SecretProvider = { name: "boom2", get: async () => "x", presence: async () => { throw new Error("x"); } };
    await expect(gatewayOver(boomPresence).secretPresence("R")).resolves.toBeNull();
  });

  it("secretsHealth: kildens helse, og healthy for en kilde som ikke kan feile", () => {
    expect(gatewayOver(plain(null)).secretsHealth()).toBe("healthy");
    expect(gatewayOver(plain(null, "unavailable")).secretsHealth()).toBe("unavailable");
    expect(gatewayOver(plain(null, "unconfigured")).secretsHealth()).toBe("unconfigured");
  });
});

describe("FallbackSecretProvider: presence for kjeden", () => {
  const present: SecretProvider = { name: "p", get: async () => "v" };
  const absentHealthy: SecretProvider = { name: "a", get: async () => null, health: "healthy" };
  const down: SecretProvider = { name: "d", get: async () => null, health: "unavailable" };
  const chain = (a: SecretProvider, b: SecretProvider): FallbackSecretProvider => new FallbackSecretProvider(a, b);
  const table: Array<[string, SecretProvider, SecretProvider, SecretPresence]> = [
    ["primær har verdien", present, absentHealthy, "present"],
    ["primær nede, fallback har verdien (rollback til .env virker)", down, present, "present"],
    ["begge har svart «finnes ikke»", absentHealthy, absentHealthy, "absent"],
    ["primær NEDE og fallback mangler - verdien kan ligge i primær: UKJENT", down, absentHealthy, "unknown"],
    ["primær frisk og fallback nede", absentHealthy, down, "unknown"],
    ["begge nede", down, down, "unknown"]
  ];
  for (const [label, a, b, expected] of table) {
    it(label, async () => {
      expect(await chain(a, b).presence("R")).toBe(expected);
    });
  }

  it("kjedens helse er den verste av delene; kilder uten helse teller ikke", () => {
    expect(chain(down, absentHealthy).health).toBe("unavailable");
    expect(chain(absentHealthy, absentHealthy).health).toBe("healthy");
    expect(chain({ name: "u", get: async () => null, health: "unconfigured" }, present).health).toBe("unconfigured");
    expect(chain(present, present).health).toBeUndefined();
  });

  it("en del som kaster gir ukjent (aldri et unntak videre)", async () => {
    const boom: SecretProvider = { name: "boom", get: async () => { throw new Error("x"); } };
    expect(await chain(boom, absentHealthy).presence("R")).toBe("unknown");
    expect(await chain(boom, present).presence("R")).toBe("present");
  });

  it("get() er uendret: første ikke-null verdi, ellers null", async () => {
    expect(await chain(down, present).get("R")).toBe("v");
    expect(await chain(down, absentHealthy).get("R")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Infisical mot en ekte lokal HTTP-server (guardedFetch tillater http://127.0.0.1:port)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
interface FakeInfisical {
  url: string;
  logins: number;
  gets: number;
  mode: "ok" | "down" | "login_fail" | "unauthorized" | "garbage";
  secrets: Map<string, string>;
  delayMs: number;
  maxInflight: number;
  stop: () => Promise<void>;
}

async function startFakeInfisical(): Promise<FakeInfisical> {
  const state = { logins: 0, gets: 0, mode: "ok" as FakeInfisical["mode"], secrets: new Map<string, string>(), delayMs: 0, inflight: 0, maxInflight: 0 };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    if (req.method === "POST" && req.url?.startsWith("/api/v1/auth/universal-auth/login")) {
      state.logins += 1;
      req.resume();
      const finish = (): void => (state.mode === "login_fail" ? respond(500, { error: "boom" }) : respond(200, { accessToken: "t-123" }));
      if (state.delayMs > 0) setTimeout(finish, state.delayMs); else finish();
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/v3/secrets/raw/")) {
      state.gets += 1;
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      const ref = decodeURIComponent((req.url.split("?")[0] ?? "").slice("/api/v3/secrets/raw/".length));
      const finish = (): void => {
        state.inflight -= 1;
        if (state.mode === "down") return respond(503, { error: "unavailable" });
        if (state.mode === "unauthorized") return respond(401, { error: "expired" });
        if (state.mode === "garbage") return respond(200, "ikke json");
        const value = state.secrets.get(ref);
        return value === undefined ? respond(404, { error: "not found" }) : respond(200, { secret: { secretValue: value } });
      };
      if (state.delayMs > 0) setTimeout(finish, state.delayMs); else finish();
      return;
    }
    respond(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get logins() { return state.logins; },
    get gets() { return state.gets; },
    get mode() { return state.mode; },
    set mode(m) { state.mode = m; },
    get maxInflight() { return state.maxInflight; },
    get delayMs() { return state.delayMs; },
    set delayMs(ms) { state.delayMs = ms; },
    secrets: state.secrets,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  } as FakeInfisical;
}

describe("InfisicalSecretProvider.presence mot en ekte lokal server", () => {
  let fake: FakeInfisical | undefined;
  afterEach(async () => { await fake?.stop(); fake = undefined; });
  const provider = (url: string): InfisicalSecretProvider => new InfisicalSecretProvider(url, "client-id", "client-secret", "project-id", "dev");

  it("finnes → present, 404 → absent (en måling, kilden svarte), begge med health = healthy", async () => {
    fake = await startFakeInfisical();
    fake.secrets.set("JARVIS_A", "verdi");
    const p = provider(fake.url);
    expect(await p.presence("JARVIS_A")).toBe("present");
    expect(p.health).toBe("healthy");
    expect(await p.presence("JARVIS_FINNES_IKKE")).toBe("absent");
    expect(p.health).toBe("healthy");
  });

  it("5xx, ugyldig svar og utløpt token → UKJENT (aldri absent), health = unavailable, mens get() fortsatt gir null (fail-closed ved kall)", async () => {
    fake = await startFakeInfisical();
    fake.secrets.set("JARVIS_A", "verdi");
    for (const mode of ["down", "garbage", "unauthorized"] as const) {
      fake.mode = mode;
      const p = provider(fake.url);
      expect(await p.presence("JARVIS_A"), mode).toBe("unknown");
      expect(p.health, mode).toBe("unavailable");
      expect(await p.get("JARVIS_A"), mode).toBeNull();
    }
  });

  it("innloggingen feiler → UKJENT; neste oppslag prøver innloggingen på nytt og lykkes når kilden er tilbake", async () => {
    fake = await startFakeInfisical();
    fake.secrets.set("JARVIS_A", "verdi");
    fake.mode = "login_fail";
    const p = provider(fake.url);
    expect(await p.presence("JARVIS_A")).toBe("unknown");
    expect(fake.logins).toBe(1);
    fake.mode = "ok";
    expect(await p.presence("JARVIS_A")).toBe("present");
    expect(fake.logins).toBe(2);
    expect(p.health).toBe("healthy");
  });

  it("kilden er nede (tilkobling avvist) → UKJENT; ikke konfigurert → absent (ikke i bruk) med health = unconfigured", async () => {
    const unreachable = provider("http://127.0.0.1:9"); // port 9 (discard) lytter ikke
    expect(await unreachable.presence("JARVIS_A")).toBe("unknown");
    expect(unreachable.health).toBe("unavailable");
    const unconfigured = new InfisicalSecretProvider(undefined, undefined, undefined, undefined);
    expect(await unconfigured.presence("JARVIS_A")).toBe("absent");
    expect(unconfigured.health).toBe("unconfigured");
  });

  it("en utrygg INFISICAL_URL er en konfig-feil, men presence er likevel UKJENT (kunne ikke måles), ikke absent", async () => {
    const p = new InfisicalSecretProvider("http://user:pw@127.0.0.1:1", "id", "secret", "proj", "dev");
    expect(await p.presence("JARVIS_A")).toBe("unknown");
  });
});

describe("hele kjeden slik main.ts setter den sammen (Infisical → .env), mot en kilde som er nede", () => {
  let fake: FakeInfisical | undefined;
  afterEach(async () => { await fake?.stop(); fake = undefined; });

  it("REPRO fra gjennomgangen: Infisical nede + FallbackSecretProvider + ekte ToolGateway → hver ref er UKJENT (null), aldri false; en ref som finnes i .env er fortsatt true", async () => {
    const saved = process.env["JARVIS_TEST_ENV_ONLY"];
    process.env["JARVIS_TEST_ENV_ONLY"] = "fra-env";
    try {
      fake = await startFakeInfisical();
      fake.mode = "down";
      const infisical = new InfisicalSecretProvider(fake.url, "client-id", "client-secret", "project-id", "dev");
      const gateway = gatewayOver(new FallbackSecretProvider(infisical, new FallbackSecretProvider(new EnvSecretProvider(), { name: "intern", get: async () => null })));
      expect(await gateway.secretPresence("JARVIS_MANGLER")).toBeNull();
      expect(await gateway.secretPresence("JARVIS_TEST_ENV_ONLY")).toBe(true);
      expect(gateway.secretsHealth()).toBe("unavailable");
      // kilden kommer tilbake: samme spørring er nå en MÅLING
      fake.mode = "ok";
      expect(await gateway.secretPresence("JARVIS_MANGLER")).toBe(false);
      expect(gateway.secretsHealth()).toBe("healthy");
    } finally {
      if (saved === undefined) delete process.env["JARVIS_TEST_ENV_ONLY"]; else process.env["JARVIS_TEST_ENV_ONLY"] = saved;
    }
  });
});

describe("L-3: samtidige oppslag deler ÉN innlogging", () => {
  let fake: FakeInfisical | undefined;
  afterEach(async () => { await fake?.stop(); fake = undefined; });

  it("40 samtidige presence()-kall (uten token fra før) gir nøyaktig ÉN innlogging og 40 oppslag", async () => {
    fake = await startFakeInfisical();
    fake.delayMs = 25;
    const p = new InfisicalSecretProvider(fake.url, "client-id", "client-secret", "project-id", "dev");
    const refs = Array.from({ length: 40 }, (_, i) => `JARVIS_REF_${i}`);
    const results = await Promise.all(refs.map((r) => p.presence(r)));
    expect(results.every((r) => r === "absent")).toBe(true);
    expect(fake.logins).toBe(1);
    expect(fake.gets).toBe(40);
    // token gjenbrukes av senere oppslag (ingen ny innlogging)
    await p.presence("JARVIS_REF_X");
    expect(fake.logins).toBe(1);
  });

  it("samtidige get()-kall deler også innloggingen, og en mislykket innlogging deles av alle som ventet - deretter prøves den på nytt", async () => {
    fake = await startFakeInfisical();
    fake.delayMs = 25;
    fake.mode = "login_fail";
    const p = new InfisicalSecretProvider(fake.url, "client-id", "client-secret", "project-id", "dev");
    const first = await Promise.all(Array.from({ length: 10 }, (_, i) => p.get(`JARVIS_REF_${i}`)));
    expect(first.every((v) => v === null)).toBe(true);
    expect(fake.logins).toBe(1); // alle 10 ventet på den ene mislykkede innloggingen
    fake.mode = "ok";
    fake.secrets.set("JARVIS_REF_0", "v");
    expect(await p.get("JARVIS_REF_0")).toBe("v");
    expect(fake.logins).toBe(2);
  });

  it("utløpt token (401) nullstiller tokenet: neste oppslag logger inn på nytt - én gang, selv med mange samtidige", async () => {
    fake = await startFakeInfisical();
    fake.secrets.set("JARVIS_REF_0", "v");
    const p = new InfisicalSecretProvider(fake.url, "client-id", "client-secret", "project-id", "dev");
    expect(await p.get("JARVIS_REF_0")).toBe("v");
    expect(fake.logins).toBe(1);
    fake.mode = "unauthorized";
    expect(await p.get("JARVIS_REF_0")).toBeNull(); // 401 → token nullstilt
    fake.mode = "ok";
    fake.delayMs = 20;
    const again = await Promise.all(Array.from({ length: 12 }, () => p.get("JARVIS_REF_0")));
    expect(again.every((v) => v === "v")).toBe(true);
    expect(fake.logins).toBe(2);
  });
});
