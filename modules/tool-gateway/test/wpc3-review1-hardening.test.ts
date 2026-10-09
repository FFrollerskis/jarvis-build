import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubAppAuth, GitHubAppAuthError, maskGitHubSecrets, normalizeGitHubApiBase, parseGitHubAppPrivateKey } from "../src/github-app-auth.ts";
import { createGitHubAuth, resolveGitHubAuthSettings } from "../src/github-token-provider.ts";
import { listConnectorStatus } from "../src/connector-registry.ts";
import { ToolGateway, type SecretProvider } from "../src/gateway.ts";
import { fakeRsaPrivateKeyPem } from "./support/fake-rsa-der.ts";
import { FakeGitHubApp } from "./support/fake-github-app.ts";
import { APP_ID, INSTALLATION_ID, OTHER_REPO, REPO, T0, failure, harness, keys, stopFakeServers } from "./support/wpc3-harness.ts";

/**
 * WP-C3, rettelser etter den UAVHENGIGE sikkerhetsreviewen (PR #311). Hver `describe` bærer funn-id-en (F1, F4, ...) og er skrevet slik at den
 * FEILER mot koden slik den var før rettelsen (verifisert ved å reversere rettelsen lokalt, se commit-meldingene).
 */

const listeners: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await stopFakeServers();
  while (listeners.length > 0) await listeners.pop()?.stop();
});

interface Hit { readonly method: string; readonly path: string; readonly authorization: string | null }
interface Listener { readonly url: string; readonly hits: Hit[]; stop(): Promise<void> }

/** Minimal HTTP-lytter på 127.0.0.1 som husker hva den ble spurt om (brukes som «mottaker» og som redirect-kilde). */
async function listen(respond: (req: IncomingMessage, res: ServerResponse, self: { url: string }) => void): Promise<Listener> {
  const hits: Hit[] = [];
  const self = { url: "" };
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? "GET", path: req.url ?? "/", authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : null });
    req.resume();
    respond(req, res, self);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  self.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const listener: Listener = {
    url: self.url, hits,
    stop: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  };
  listeners.push(listener);
  return listener;
}

// PEM-rammer bygges dynamisk, slik at hemmelighetsskannere (gitleaks) ikke tar test-fikstureringen for en ekte nøkkel.
const BEGIN_PKCS8 = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const BEGIN_RSA = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const END_RSA = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
const BEGIN_ONLY = ["-----BEGIN", ""].join(" ");

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F1: maskeringen er lineær i inndata-lengden (ReDoS) og kutter inndata FØR regexene kjører", () => {
  const sized = (unit: string, size: number, suffix = ""): string => unit.repeat(Math.ceil(size / unit.length)) + suffix;

  // Fiendtlig inndata per maskeringsregex (JWT, PEM, token, Bearer) pluss blandinger. Alle er konstruert for å gi motoren mange mislykkede
  // startpunkter innenfor ÉN lang tegnkjede - den klassiske veien til O(n²).
  const HOSTILE: Array<[string, (size: number) => string]> = [
    ["JWT: «eyJ» i én lang kjede", (n) => sized("eyJ", n)],
    ["JWT: «eyJ»-kjede avsluttet med punktum", (n) => sized("eyJ", n, ".")],
    ["JWT: «eyJ»-kjede med to punktum og ingen avslutning", (n) => `${sized("eyJ", n / 2)}.${sized("eyJ", n / 2)}.`],
    ["JWT: «eyJ_»-kjede (understrek er en del av tegnklassen)", (n) => sized("eyJ_", n)],
    ["JWT: «eyJ-»-kjede (bindestrek er en del av tegnklassen)", (n) => sized("eyJ-", n)],
    ["JWT: lovlige ledd i det uendelige", (n) => sized("eyJaaaa.", n)],
    ["PEM: BEGIN-rammer uten END", (n) => sized(BEGIN_PKCS8, n)],
    ["PEM: «-----BEGIN » gjentatt", (n) => sized(BEGIN_ONLY, n)],
    ["PEM: BEGIN fulgt av én lang etikett uten «PRIVATE KEY»", (n) => `${BEGIN_ONLY}${"A".repeat(n)}`],
    ["PEM: mange komplette korte nøkler", (n) => sized(`${BEGIN_RSA}\nAAAA\n${END_RSA}\n`, n)],
    ["token: «ghp_» gjentatt", (n) => sized("ghp_", n)],
    ["token: ett tegn for kort etter prefikset, gjentatt", (n) => sized("ghp_aaaaaaaaaaa ", n)],
    ["token: «github_pat_» gjentatt", (n) => sized("github_pat_", n)],
    ["token: «gh» gjentatt", (n) => sized("gh", n)],
    ["Bearer: «Bearer » gjentatt", (n) => sized("Bearer ", n)],
    ["Bearer: «token» fulgt av et hav av mellomrom", (n) => `token${" ".repeat(n)}`],
    ["Bearer: elleve tegn (ett for kort), gjentatt", (n) => sized("Bearer aaaaaaaaaaa ", n)],
    ["Bearer: «token»+tab gjentatt", (n) => sized("token\t", n)],
    ["blanding av alle", (n) => sized(`eyJ${BEGIN_ONLY}ghp_Bearer token `, n)]
  ];

  it("F1a: alle regexene bruker < 1 s på fiendtlig inndata opptil 512 KB (eskalerende størrelser, så en regresjon feiler raskt og ikke henger)", () => {
    for (const [name, make] of HOSTILE) {
      for (const size of [16_384, 65_536, 524_288]) {
        const input = make(size);
        const started = performance.now();
        const masked = maskGitHubSecrets(input);
        const elapsed = performance.now() - started;
        expect(elapsed, `${name} @ ${size} tegn tok ${Math.round(elapsed)} ms`).toBeLessThan(1_000);
        expect(typeof masked).toBe("string");
      }
    }
  });

  it("F1b: mange eksakte kjente hemmeligheter mot en stor tekst er også raskt (split/join er lineært per hemmelighet)", () => {
    const text = sized("a", 524_288);
    const secrets = Array.from({ length: 50 }, (_, i) => "a".repeat(8 + i));
    const started = performance.now();
    maskGitHubSecrets(text, secrets);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("F1c: feilmeldingen (safeDetail via GitHubAppAuthError) kutter til en kort detalj, også for fiendtlig inndata på 512 KB", () => {
    for (const [name, make] of HOSTILE) {
      const started = performance.now();
      const error = new GitHubAppAuthError("GITHUB_APP_REQUEST_REJECTED", make(524_288));
      const elapsed = performance.now() - started;
      expect(elapsed, `${name} tok ${Math.round(elapsed)} ms`).toBeLessThan(1_000);
      expect(error.message.length).toBeLessThanOrEqual("GITHUB_APP_REQUEST_REJECTED:".length + 160);
    }
  });

  it("F1d: en fiendtlig 422-respons (21 000 × «eyJ», reprodusert fra reviewen: 7,9 s) stanser ikke event-loopen - og 510 KB er like raskt", async () => {
    for (const repeat of [21_000, 170_000]) {
      const h = await harness({ overrides: { maxAttempts: 1 } });
      h.fake.script = [{ status: 422, json: { message: "eyJ".repeat(repeat) } }];
      const started = performance.now();
      const error = await failure(h.auth.token());
      const elapsed = performance.now() - started;
      expect(error.code).toBe("GITHUB_APP_REQUEST_REJECTED");
      expect(elapsed, `${repeat} × eyJ tok ${Math.round(elapsed)} ms`).toBeLessThan(1_000);
      expect(error.message.length).toBeLessThan(200);
      await stopFakeServers();
    }
  });

  it("F1e: kuttet inndata svekker ikke maskeringen: hemmeligheter nær starten maskeres, og hemmeligheter bak vinduet slippes aldri inn i meldingen", () => {
    const token = `${["gh", "s_"].join("")}${"A1b2C3d4".repeat(6)}`;
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(40)}.${"b".repeat(40)}`;
    const near = new GitHubAppAuthError("GITHUB_APP_FORBIDDEN", `feil ${token} og ${jwt} her`);
    expect(near.message).not.toContain(token);
    expect(near.message).not.toContain(jwt);
    expect(near.message).toContain("[REDACTED_TOKEN]");
    expect(near.message).toContain("[REDACTED_JWT]");
    const behind = new GitHubAppAuthError("GITHUB_APP_FORBIDDEN", `${"støy ".repeat(600)}${token} ${jwt}`);
    expect(behind.message).not.toContain(token.slice(0, 20));
    expect(behind.message).not.toContain(jwt.slice(0, 20));
  });

  it("F1g: inndata kuttes til ca. 2 KB FØR maskering (MASK_INPUT_LIMIT) - tekst bak vinduet når aldri meldingen, selv om maskeringen krymper det som står foran", () => {
    // En 5000 tegn lang PEM-blokk (masker -> «[REDACTED_KEY]») fulgt av en hale. Med kutt FØR maskering er blokken avkortet ved 2048 tegn (uavsluttet blokk maskeres ut til slutten, halen er borte);
    // uten kutt (eller med et vindu på 64 KB) ville blokken blitt maskert hel og halen kommet med i den korte detaljen.
    const block = `${BEGIN_PKCS8}\n${"A".repeat(5_000)}\n${["-----END", "PRIVATE KEY-----"].join(" ")}`;
    const error = new GitHubAppAuthError("GITHUB_APP_FORBIDDEN", `${block} SYNLIG_HALE`);
    expect(error.message).toContain("[REDACTED_KEY]");
    expect(error.message).not.toContain("AAAA");
    expect(error.message).not.toContain("SYNLIG_HALE");
    // Kortere inndata (innenfor vinduet) beholder halen - kuttet er altså ikke bare «alltid tomt».
    const short = new GitHubAppAuthError("GITHUB_APP_FORBIDDEN", `${BEGIN_PKCS8}\nAAAA\n${["-----END", "PRIVATE KEY-----"].join(" ")} SYNLIG_HALE`);
    expect(short.message).toContain("SYNLIG_HALE");
  });

  it("F1f: en server som limer et bokstavprefiks foran JWT-en vi sendte (slipper unna lookbehind-mønsteret) får den likevel maskert - eksakt kjent JWT", async () => {
    const h = await harness({ overrides: { maxAttempts: 1 } });
    const seen: string[] = [];
    h.fake.script = [{ status: 401, build: (req) => { if (req.bearer) seen.push(req.bearer); return { status: 401, json: { message: `A${req.bearer ?? ""}B` } }; } }];
    const error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_AUTH_FAILED");
    expect(seen).toHaveLength(1);
    const jwt = seen[0] as string;
    expect(error.message).not.toContain(jwt);
    expect(error.message).not.toContain(jwt.slice(0, 40));
    expect(error.message).not.toContain(jwt.split(".")[1] as string);
    expect(JSON.stringify(error)).not.toContain(jwt.slice(0, 40));
    expect(JSON.stringify(h.auth.state())).not.toContain(jwt.slice(0, 40));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F5: API-basen er KUN https://api.github.com - JWT-en kan ikke sendes til en annen vert", () => {
  it("F5a: standard/tom/«api.github.com» med skråstrek eller store bokstaver i verten godtas; ALT annet avvises (GHES er DEFERRED)", () => {
    expect(normalizeGitHubApiBase(undefined)).toBe("https://api.github.com");
    expect(normalizeGitHubApiBase("  ")).toBe("https://api.github.com");
    expect(normalizeGitHubApiBase("https://api.github.com/")).toBe("https://api.github.com");
    expect(normalizeGitHubApiBase("https://API.GitHub.COM")).toBe("https://api.github.com");
    expect(normalizeGitHubApiBase("https://api.github.com:443")).toBe("https://api.github.com");
    for (const bad of [
      "https://evil.example", "https://ghe.firma.no/api/v3", "https://github.com", "https://api.githubusercontent.com", "https://xapi.github.com",
      "https://api.github.com.evil.example", "https://evil.example/api.github.com", "https://api.github.com.", "https://api.github.com:8443",
      "https://api.github.com/api/v3", "https://api.github.com/x", "https://api.github.com@evil.example", "https://user:pw@api.github.com",
      "http://api.github.com", "https://api.github.com?x=1", "https://127.0.0.1", "https://[::1]"
    ]) {
      expect(() => normalizeGitHubApiBase(bad), bad).toThrow(GitHubAppAuthError);
    }
    expect(() => normalizeGitHubApiBase("https://ghe.firma.no/api/v3")).toThrow(/api_base_host_not_allowed/);
    expect(() => normalizeGitHubApiBase("https://api.github.com:8443")).toThrow(/api_base_port_not_allowed/);
    expect(() => normalizeGitHubApiBase("https://api.github.com/api/v3")).toThrow(/api_base_path_not_allowed/);
  });

  it("F5b: konstruktøren og miljøoppløsningen feiler LUKKET for en annen vert - før noe kall er gjort", () => {
    expect(() => new GitHubAppAuth({ appId: "1", installationId: "2", privateKey: async () => keys.pkcs1, repositories: [REPO], apiBase: "https://evil.example" })).toThrow(/api_base_host_not_allowed/);
    const env = { JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO };
    const settings = resolveGitHubAuthSettings({ ...env, JARVIS_GITHUB_API_BASE: "https://evil.example" });
    expect(settings.kind).toBe("invalid");
    expect(settings.kind === "invalid" && settings.error.message).toContain("api_base_host_not_allowed");
    expect(resolveGitHubAuthSettings({ ...env, JARVIS_GITHUB_API_BASE: "https://api.github.com" }).kind).toBe("app");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F5c: redirects følges aldri på kall som bærer JWT eller installasjonstoken", () => {
  function clientFor(base: string): GitHubAppAuth {
    return new GitHubAppAuth({
      appId: APP_ID, installationId: INSTALLATION_ID, privateKey: async () => keys.pkcs1, repositories: [REPO], apiBase: base,
      allowLoopbackHttpForTests: true, sleep: async () => undefined, log: () => undefined
    });
  }

  it("F5c1: en 307 til en ANNEN opprinnelse følges ikke (mottakeren får aldri en forespørsel), ingen retry, presis feilkode", async () => {
    const recipient = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    const redirector = await listen((_req, res) => { res.writeHead(307, { location: `${recipient.url}/mottaker` }); res.end(); });
    const auth = clientFor(redirector.url);
    const error = await failure(auth.token());
    expect(error.code).toBe("GITHUB_APP_RESPONSE_INVALID");
    expect(error.message).toContain("unexpected_redirect_http_307");
    expect(redirector.hits).toHaveLength(1); // 3xx er ikke «nettverksfeil»: ingen backoff-gjentakelse
    expect(recipient.hits).toHaveLength(0);
  });

  it("F5c2: en 301/302/308 til SAMME opprinnelse (der Authorization ellers ville fulgt med) følges heller ikke - JWT-en sendes nøyaktig én gang", async () => {
    for (const status of [301, 302, 308]) {
      const redirector = await listen((_req, res, self) => { res.writeHead(status, { location: `${self.url}/annet-sted` }); res.end(); });
      const error = await failure(clientFor(redirector.url).inspectInstallation());
      expect(error.code, String(status)).toBe("GITHUB_APP_RESPONSE_INVALID");
      expect(redirector.hits.map((h) => h.path), String(status)).toEqual([`/app/installations/${INSTALLATION_ID}`]);
    }
  });

  it("F5c3: revoke() (bærer installasjonstokenet) følger heller ingen redirect", async () => {
    const recipient = await listen((_req, res) => { res.writeHead(204); res.end(); });
    const redirector = await listen((_req, res) => { res.writeHead(307, { location: `${recipient.url}/revoke` }); res.end(); });
    const error = await failure(clientFor(redirector.url).revoke(`${["gh", "s_"].join("")}${"Z9y8X7w6".repeat(5)}`));
    expect(error.code).toBe("GITHUB_APP_REQUEST_REJECTED");
    expect(error.message).toContain("revoke_http_307");
    expect(recipient.hits).toHaveLength(0);
    expect(redirector.hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F6: PAT-fallback slås kun på av EKSAKT «true» (docs sier det - koden var case-insensitiv)", () => {
  const env = { JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO };

  it("F6a: bare «true» gir allowPatFallback; alle andre varianter (store bokstaver, mellomrom, tegn rundt) gjør det ikke", () => {
    for (const value of ["TRUE", "True", "tRue", " true", "true ", "\ttrue", "true\n", "'true'", "\"true\"", "yes", "1", "on", "enabled", "truee", ""]) {
      const settings = resolveGitHubAuthSettings({ ...env, JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: value });
      expect(settings.kind === "app" && settings.allowPatFallback, JSON.stringify(value)).toBe(false);
    }
    const exact = resolveGitHubAuthSettings({ ...env, JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" });
    expect(exact.kind === "app" && exact.allowPatFallback).toBe(true);
  });

  it("F6b: med «TRUE» faller Jarvis IKKE tilbake til PAT når utstedelsen feiler - fail-closed i praksis, ikke bare i innstillingene", async () => {
    const h = await harness();
    const secrets = { name: "map", get: async (ref: string) => (ref === "JARVIS_GITHUB_TOKEN" ? "pat-skal-aldri-brukes-0123456789" : ref === "JARVIS_GITHUB_APP_PRIVATE_KEY" ? keys.pkcs1 : null) };
    const auth = createGitHubAuth({
      secrets, allowLoopbackHttpForTests: true, log: () => undefined, sleep: async () => undefined, maxAttempts: 1,
      env: { ...env, JARVIS_GITHUB_API_BASE: h.fake.baseUrl, JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "TRUE" }
    });
    h.fake.script = [{ status: 404, json: { message: "Not Found" } }];
    expect(await auth.secretProvider(secrets).get("JARVIS_GITHUB_TOKEN")).toBeNull();
    expect(auth.status().pat_fallback).toEqual({ allowed: false, active: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F8: fail-fast-vinduet dobles for PERMANENTE feil (5, 10, 20, ... s, tak 5 min) og nullstilles av første suksess", () => {
  /** Kjører `windows.length` mislykkede utstedelser på rad og kontrollerer at vinduet etter hver av dem er NØYAKTIG det forventede. */
  async function exerciseWindows(h: Awaited<ReturnType<typeof harness>>, windowsMs: number[], scope?: { repositories: string[] }): Promise<void> {
    for (const [i, windowMs] of windowsMs.entries()) {
      const before = h.fake.mintRequests().length;
      await failure(h.auth.token(scope));
      expect(h.fake.mintRequests().length, `forsøk ${i + 1} skal gå mot GitHub`).toBe(before + 1);
      h.clock.t += windowMs - 1; // rett FØR vinduet er over: fail-fast, ingen nye kall
      await failure(h.auth.token(scope));
      expect(h.fake.mintRequests().length, `vindu ${i + 1} (${windowMs} ms) skal stenge for nye kall`).toBe(before + 1);
      h.clock.t += 1; // vinduet er over: neste kall går mot GitHub igjen
    }
  }

  it("F8a: 401 på rad gir 5, 10, 20, 40, 80, 160 og så 300 s (tak) - en feilkonfigurert App hamrer ikke GitHub hvert 5. sekund", async () => {
    const h = await harness({ overrides: { maxAttempts: 1 } });
    const windows = [5, 10, 20, 40, 80, 160, 300, 300].map((s) => s * 1_000);
    h.fake.script = windows.map(() => ({ status: 401, json: { message: "Bad credentials" } }));
    await exerciseWindows(h, windows);
  });

  it("F8b: 5xx (UNAVAILABLE) starter på 10 s og dobles: 10, 20, 40, ...; alle andre permanente koder (404, 403, 422) dobles likt fra 5 s", async () => {
    const unavailable = await harness({ overrides: { maxAttempts: 1 } });
    unavailable.fake.script = [10, 20, 40, 80].map(() => ({ status: 503, json: { message: "unavailable" } }));
    await exerciseWindows(unavailable, [10_000, 20_000, 40_000, 80_000]);
    for (const status of [404, 403, 422, 400]) {
      const h = await harness({ overrides: { maxAttempts: 1 } });
      h.fake.script = [0, 1, 2].map(() => ({ status, json: { message: "avvist" } }));
      await exerciseWindows(h, [5_000, 10_000, 20_000]);
    }
  });

  it("F8c: første suksess nullstiller telleren - neste feil gir igjen et 5 s-vindu, ikke fortsettelsen av doblingen", async () => {
    const h = await harness({ overrides: { maxAttempts: 1, repositories: [REPO, OTHER_REPO] } });
    h.fake.script = [401, 401, 401].map((status) => ({ status, json: { message: "Bad credentials" } }));
    await exerciseWindows(h, [5_000, 10_000, 20_000]); // tre feil: neste vindu ville vært 40 s
    const first = await h.auth.token(); // suksess (scriptet er tomt)
    expect(first).toMatch(/^ghs_/);
    h.clock.t += 2 * 3_600_000; // tokenet er utløpt: neste kall må utstede på nytt
    h.fake.script = [{ status: 401, json: { message: "Bad credentials" } }];
    await failure(h.auth.token());
    const afterFailure = h.fake.mintRequests().length;
    h.clock.t += 4_999;
    await failure(h.auth.token());
    expect(h.fake.mintRequests().length).toBe(afterFailure); // fortsatt innenfor 5 s
    h.clock.t += 1;
    expect(await h.auth.token()).toMatch(/^ghs_/); // 5 s var nok - ikke 40 s
  });

  it("F8d: doblingen er per scope - en feilende scope gjør ikke en annen scope tregere; rate limit følger fortsatt leverandørens Retry-After (ikke doblet)", async () => {
    const h = await harness({ overrides: { maxAttempts: 1, repositories: [REPO, OTHER_REPO] } });
    h.fake.script = [{ status: 401, json: { message: "Bad credentials" } }, { status: 401, json: { message: "Bad credentials" } }];
    await exerciseWindows(h, [5_000, 10_000], { repositories: [REPO] });
    // En annen scope har sin egen teller og er ikke stengt av den første.
    expect(await h.auth.token({ repositories: [OTHER_REPO] })).toMatch(/^ghs_/);

    const limited = await harness({ overrides: { maxAttempts: 1 } });
    limited.fake.script = [30, 30, 30].map(() => ({ status: 429, headers: { "retry-after": "30" }, json: { message: "slow down" } }));
    await exerciseWindows(limited, [30_000, 30_000, 30_000]);
  });

  it("F8e: lokale feil (nøkkel mangler) har fortsatt INGEN fail-fast - eieren kan rette opp og prøve umiddelbart, uansett hvor mange feil som er gått", async () => {
    let key: string | null = null;
    const h = await harness({ overrides: { maxAttempts: 1, privateKey: async () => key } });
    for (let i = 0; i < 6; i += 1) expect((await failure(h.auth.token())).code).toBe("GITHUB_APP_KEY_MISSING");
    key = keys.pkcs1;
    expect(await h.auth.token()).toMatch(/^ghs_/);
    expect(h.clock.t).toBe(T0); // ingen ventetid i det hele tatt
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F9: «kortlevd repo-scopet identitet» (short_lived/scoped/hardened) er et BEVIS - aldri sann før en utstedelse har lyktes", () => {
  class MapSecrets implements SecretProvider {
    readonly name = "map";
    constructor(readonly values: Record<string, string>) {}
    async get(ref: string): Promise<string | null> { return this.values[ref] ?? null; }
  }

  async function appMode(extra: Record<string, string> = {}, values: Record<string, string> = { JARVIS_GITHUB_APP_PRIVATE_KEY: keys.pkcs1 }) {
    const clock = { t: T0 };
    const fake = await FakeGitHubApp.start({ publicKey: keys.publicKey, appId: APP_ID, installationId: INSTALLATION_ID, serverNow: () => clock.t });
    const secrets = new MapSecrets(values);
    const auth = createGitHubAuth({
      secrets, allowLoopbackHttpForTests: true, now: () => clock.t, sleep: async () => undefined, maxAttempts: 1, log: () => undefined,
      env: { JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO, JARVIS_GITHUB_API_BASE: fake.baseUrl, ...extra }
    });
    const stop = async (): Promise<void> => { await fake.stop(); };
    return { fake, clock, auth, secrets, stop };
  }

  const FLAGS_OFF = { short_lived: false, scoped: false, hardened: false };
  const FLAGS_ON = { short_lived: true, scoped: true, hardened: true };

  it("F9a: konfigurert App-modus UTEN noen utstedelse ennå (app_pending) påstår hverken kortlevd, scopet eller hardened - i status, connector-metadata og EV-17-fakta", async () => {
    const m = await appMode();
    try {
      expect(m.auth.status()).toMatchObject({ method: "app", state: "app_pending", ...FLAGS_OFF });
      const info = m.auth.connectorAuthInfo();
      expect(info).toMatchObject({ method: "app", short_lived: false, scoped: false });
      expect(info.detail).toMatchObject({ state: "app_pending", hardened: false });
      expect(m.auth.credentialFacts()).toMatchObject({ auth_method: "app", short_lived: false, repo_scoped: false, last_refresh_ok: null });
      expect(m.fake.requests).toHaveLength(0); // statusavlesning utsteder ingenting
    } finally {
      await m.stop();
    }
  });

  it("F9b: først etter en VELLYKKET utstedelse blir alle tre flaggene sanne (og forblir det når cachen utløper uten feil - fornyelse skjer ved neste bruk)", async () => {
    const m = await appMode();
    try {
      const provider = m.auth.secretProvider(m.secrets);
      expect(await provider.get("JARVIS_GITHUB_TOKEN")).toMatch(/^ghs_/);
      expect(m.auth.status()).toMatchObject({ state: "app_ok", ...FLAGS_ON });
      expect(m.auth.connectorAuthInfo()).toMatchObject({ short_lived: true, scoped: true });
      expect(m.auth.credentialFacts()).toMatchObject({ short_lived: true, repo_scoped: true });
      m.clock.t += 2 * 3_600_000; // cachen er utløpt, men det har ikke vært noen feil
      const idle = m.auth.status();
      expect(idle.app?.token).toBeNull();
      expect(idle).toMatchObject({ state: "app_ok", ...FLAGS_ON });
    } finally {
      await m.stop();
    }
  });

  it("F9c: feil før første utstedelse, ugyldig konfig og en feilet fornyelse etter utløp gir app_error med alle flaggene av", async () => {
    const failing = await appMode();
    try {
      failing.fake.script = [{ status: 404, json: { message: "Not Found" } }];
      expect(await failing.auth.secretProvider(failing.secrets).get("JARVIS_GITHUB_TOKEN")).toBeNull();
      expect(failing.auth.status()).toMatchObject({ state: "app_error", ...FLAGS_OFF });
    } finally {
      await failing.stop();
    }
    const invalid = await appMode({ JARVIS_GITHUB_APP_INSTALLATION_ID: "" });
    try {
      expect(invalid.auth.status()).toMatchObject({ state: "app_error", ...FLAGS_OFF });
    } finally {
      await invalid.stop();
    }
    const renewal = await appMode();
    try {
      const provider = renewal.auth.secretProvider(renewal.secrets);
      expect(await provider.get("JARVIS_GITHUB_TOKEN")).toMatch(/^ghs_/);
      renewal.clock.t += 2 * 3_600_000;
      renewal.fake.script = [{ status: 401, json: { message: "Bad credentials" } }];
      expect(await provider.get("JARVIS_GITHUB_TOKEN")).toBeNull();
      expect(renewal.auth.status()).toMatchObject({ state: "app_error", ...FLAGS_OFF });
    } finally {
      await renewal.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F14: allowlisten håndheves i GitHubAppAuth selv (ikke bare i GitHubAuth), og rapportert utløp kappes", () => {
  it("F14a: et eksplisitt scope utenfor den konfigurerte listen avvises UTEN nettverkskall (SCOPE_MISMATCH) og forgifter ikke status eller ventetid", async () => {
    const h = await harness(); // allowlist = [REPO]
    for (const repositories of [[OTHER_REPO], ["other-repo"], ["fremmed/jarvisbuild"], [REPO, OTHER_REPO], ["tsworkflow/jarvisbuild-annet"]]) {
      const error = await failure(h.auth.token({ repositories }));
      expect(error.code, repositories.join(",")).toBe("GITHUB_APP_SCOPE_MISMATCH");
      expect(error.message).toContain("repository_not_in_configured_scope");
      expect((await failure(h.auth.issue({ repositories }))).code).toBe("GITHUB_APP_SCOPE_MISMATCH");
    }
    expect(h.fake.requests).toHaveLength(0);
    expect(h.auth.state().last_error).toBeNull();
    expect(h.auth.state().consecutive_failures).toBe(0);
    expect(h.logs.some((l) => l.msg === "github_app_scope_denied")).toBe(true);
    // Standard-credentialen virker uforstyrret rett etter avslagene (ingen fail-fast-vindu).
    expect(await h.auth.token()).toMatch(/^ghs_/);
    expect(h.fake.mintRequests()).toHaveLength(1);
  });

  it("F14b: delmengder av allowlisten er lov i alle skrivemåter (navn, owner/navn, store bokstaver) og deler cache - men aldri flere repoer enn listen", async () => {
    const h = await harness({ installationRepos: ["jarvisbuild", "other-repo"], overrides: { repositories: [REPO, OTHER_REPO] } });
    const a = await h.auth.token({ repositories: [REPO] });
    expect(await h.auth.token({ repositories: ["jarvisbuild"] })).toBe(a);
    expect(await h.auth.token({ repositories: ["TSWORKFLOW/JARVISBUILD"] })).toBe(a);
    expect(h.fake.mintRequests()).toHaveLength(1);
    expect(JSON.parse(h.fake.mintRequests()[0]?.body ?? "{}")).toEqual({ repositories: ["jarvisbuild"] });
    const both = await h.auth.token({ repositories: ["other-repo", REPO] });
    expect(both).toBe(await h.auth.token()); // hele listen = standard-scopet
    expect((await failure(h.auth.token({ repositories: [REPO, OTHER_REPO, "tsworkflow/tredje"] }))).code).toBe("GITHUB_APP_SCOPE_MISMATCH");
    expect(h.auth.state().last_error).toBeNull();
  });

  it("F14c: en allowlist-oppføring MED eier binder svaret til den eieren selv om kallet bare oppga navnet - en server som svarer med et annet eier-repo avvises", async () => {
    const h = await harness();
    h.fake.script = [{ status: 201, build: () => ({ status: 201, json: { ...h.fake.buildTokenBody({ repositories: ["jarvisbuild"] }), repositories: [{ id: 1, name: "jarvisbuild", full_name: "fremmed/jarvisbuild" }] } }) }];
    const error = await failure(h.auth.token({ repositories: ["jarvisbuild"] })); // bare navn, men listen sier tsworkflow/jarvisbuild
    expect(error.code).toBe("GITHUB_APP_SCOPE_MISMATCH");
    expect(error.message).toContain("requested_repository_missing");
  });

  it("F14d: uten noen konfigurert liste kan INGENTING utstedes - heller ikke et eksplisitt scope (aldri «alle repoer»)", async () => {
    const h = await harness({ overrides: { repositories: undefined } });
    expect((await failure(h.auth.token({ repositories: [REPO] }))).code).toBe("GITHUB_APP_SCOPE_MISMATCH");
    expect((await failure(h.auth.token())).code).toBe("GITHUB_APP_SCOPE_UNDEFINED");
    expect(h.fake.requests).toHaveLength(0);
  });

  it("F14e: nedskalering av rettigheter uten eksplisitt repo-liste bruker hele allowlisten og er fortsatt lov", async () => {
    const h = await harness();
    const issued = await h.auth.issue({ permissions: { contents: "write" } });
    expect(issued.info.repositories).toEqual([REPO]);
    expect(JSON.parse(h.fake.mintRequests()[0]?.body ?? "{}")).toEqual({ repositories: ["jarvisbuild"], permissions: { contents: "write" } });
  });

  it("F14f: rapportert utløp (info.expires_at, status, connector-metadata) kappes til det Jarvis faktisk bruker - ikke leverandørens påstand (år 2099)", async () => {
    for (const serverSkewMs of [0, 900_000]) {
      const h = await harness({ serverSkewMs });
      h.fake.script = [{ status: 201, build: () => ({ status: 201, json: { ...h.fake.buildTokenBody({ repositories: ["jarvisbuild"] }), expires_at: "2099-01-01T00:00:00Z" } }) }];
      const issued = await h.auth.issue();
      const capped = new Date(T0 + serverSkewMs + 65 * 60_000).toISOString(); // serverens tid: nå + 65 min
      expect(issued.info.expires_at, `skjev ${serverSkewMs}`).toBe(capped);
      expect(h.auth.state().token?.expires_at).toBe(capped);
      await stopFakeServers();
    }
    const normal = await harness();
    expect((await normal.auth.issue()).info.expires_at).toBe(new Date(T0 + 3_600_000).toISOString()); // en normal time er uendret
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F4: testhull i skopekontrollen. Reviewens mutasjonskjøring (60 mutanter, 50 drept) lot disse syv leve; hver test under er skrevet for å drepe nøyaktig én av dem.
describe("F4: skopekontrollen av svaret - leverandøren kan ikke utvide scopet stille (mutasjonsfunn M01, M04a, M05, M36, M20, M21, M41)", () => {
  type Level = "read" | "write" | "admin";

  /** Én utstedelse der serveren svarer med `mutate(korrekt svar)`; returnerer feilen (eller null ved suksess). */
  async function issueWithResponse(mutate: (body: Record<string, unknown>) => Record<string, unknown>, options: { permissions?: Record<string, Level>; bareNameAllowlist?: boolean } = {}) {
    const h = await harness({ overrides: { maxAttempts: 1, ...(options.bareNameAllowlist ? { repositories: ["jarvisbuild"] } : {}) } });
    h.fake.script = [{ status: 201, build: () => ({ status: 201, json: mutate(h.fake.buildTokenBody({ repositories: ["jarvisbuild"], ...(options.permissions ? { permissions: options.permissions } : {}) })) }) }];
    try {
      const issued = await h.auth.issue(options.permissions ? { permissions: options.permissions } : undefined);
      return { error: null as GitHubAppAuthError | null, issued, h };
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubAppAuthError);
      return { error: err as GitHubAppAuthError, issued: null, h };
    }
  }

  it("F4a (M01): repository_selection=all avvises SELV OM listen inneholder nøyaktig det forespurte repoet (antall-sjekken alene fanger det ikke)", async () => {
    const { error, h } = await issueWithResponse((body) => ({ ...body, repository_selection: "all" }));
    expect(error?.code).toBe("GITHUB_APP_SCOPE_MISMATCH");
    expect(error?.message).toContain("repository_selection_not_selected");
    expect(h.auth.state().token).toBeNull(); // ingenting ble cachet
    const none = await issueWithResponse((body) => ({ ...body, repository_selection: undefined }));
    expect(none.error?.code).toBe("GITHUB_APP_RESPONSE_INVALID");
    const ok = await issueWithResponse((body) => body);
    expect(ok.error).toBeNull();
  });

  it("F4b (M04a): rettighetsnivået i svaret kan ikke overstige det forespurte (read < write < admin) - men like og lavere nivå er lov", async () => {
    const cases: Array<{ requested: Record<string, Level>; granted: Record<string, string>; ok: boolean }> = [
      { requested: { contents: "read" }, granted: { contents: "write" }, ok: false },
      { requested: { contents: "read" }, granted: { contents: "admin" }, ok: false },
      { requested: { contents: "write" }, granted: { contents: "admin" }, ok: false },
      { requested: { contents: "write" }, granted: { contents: "write" }, ok: true },
      { requested: { contents: "write" }, granted: { contents: "read" }, ok: true },
      { requested: { contents: "admin" }, granted: { contents: "admin" }, ok: true },
      { requested: { contents: "admin" }, granted: { contents: "write" }, ok: true },
      { requested: { contents: "read" }, granted: { contents: "read" }, ok: true },
      { requested: { contents: "write" }, granted: { contents: "write", issues: "read" }, ok: false } // ikke forespurt i det hele tatt
    ];
    for (const { requested, granted, ok } of cases) {
      const { error } = await issueWithResponse((body) => ({ ...body, permissions: granted }), { permissions: requested });
      const label = `forespurt ${JSON.stringify(requested)} / gitt ${JSON.stringify(granted)}`;
      if (ok) expect(error, label).toBeNull();
      else {
        expect(error?.code, label).toBe("GITHUB_APP_SCOPE_MISMATCH");
        expect(error?.message, label).toContain("permissions_exceed_request");
      }
    }
  });

  it("F4c (M05): «metadata» er KUN implisitt tillatt som read - metadata:write/admin (og write når read ble forespurt) avvises", async () => {
    const cases: Array<{ requested: Record<string, Level>; granted: Record<string, string>; ok: boolean }> = [
      { requested: { contents: "write" }, granted: { contents: "write", metadata: "read" }, ok: true },
      { requested: { contents: "write" }, granted: { contents: "write", metadata: "write" }, ok: false },
      { requested: { contents: "write" }, granted: { contents: "write", metadata: "admin" }, ok: false },
      { requested: { contents: "write", metadata: "read" }, granted: { contents: "write", metadata: "write" }, ok: false },
      { requested: { contents: "write", metadata: "read" }, granted: { contents: "write", metadata: "read" }, ok: true }
    ];
    for (const { requested, granted, ok } of cases) {
      const { error } = await issueWithResponse((body) => ({ ...body, permissions: granted }), { permissions: requested });
      const label = `forespurt ${JSON.stringify(requested)} / gitt ${JSON.stringify(granted)}`;
      if (ok) expect(error, label).toBeNull();
      else expect(error?.code, label).toBe("GITHUB_APP_SCOPE_MISMATCH");
    }
  });

  it("F4d (M36): et ugyldig full_name i svaret avvises som RESPONSE_INVALID (aldri akseptert og videresendt til status) - også når navnet ellers ville truffet", async () => {
    // Bare repo-navn i allowlisten: da sammenlignes KUN navnet, så uten slug-valideringen ville en søppel-full_name sluppet gjennom.
    for (const fullName of ["not a slug", "tsworkflow/jarvis build", "../x/jarvisbuild", "tsworkflow/jarvisbuild\n", "x".repeat(300), "", "tsworkflow", "a/b/c", "<script>/jarvisbuild"]) {
      const { error } = await issueWithResponse((body) => ({ ...body, repositories: [{ id: 1, name: "jarvisbuild", full_name: fullName }] }), { bareNameAllowlist: true });
      expect(error?.code, JSON.stringify(fullName)).toBe("GITHUB_APP_RESPONSE_INVALID");
      expect(error?.message, JSON.stringify(fullName)).toContain("repositories_malformed");
    }
    for (const bad of [{ id: 1, name: 42, full_name: "tsworkflow/jarvisbuild" }, { id: 1, name: "jarvisbuild", full_name: 42 }, { id: 1, name: "jarvisbuild" }, "jarvisbuild", null]) {
      const { error } = await issueWithResponse((body) => ({ ...body, repositories: [bad] }), { bareNameAllowlist: true });
      expect(error?.code).toBe("GITHUB_APP_RESPONSE_INVALID");
    }
    const ok = await issueWithResponse((body) => body, { bareNameAllowlist: true });
    expect(ok.error).toBeNull();
    expect(ok.issued?.info.repositories).toEqual(["tsworkflow/jarvisbuild"]);
  });

  it("F4e (M20): klokkeskjev over 24 timer læres IKKE (ingen gjentakelse, skjev forblir 0) - under 24 timer rettes det opp med én gjentakelse", async () => {
    for (const skew of [25 * 3_600_000, -25 * 3_600_000]) {
      const h = await harness({ serverSkewMs: skew });
      const error = await failure(h.auth.token());
      expect(error.code, String(skew)).toBe("GITHUB_APP_AUTH_FAILED");
      expect(h.fake.mintRequests(), String(skew)).toHaveLength(1);
      expect(h.auth.state().clock_skew_ms, String(skew)).toBe(0);
      await stopFakeServers();
    }
    for (const skew of [23 * 3_600_000, -23 * 3_600_000]) {
      const h = await harness({ serverSkewMs: skew });
      expect(await h.auth.token()).toMatch(/^ghs_/);
      expect(h.fake.mintRequests(), String(skew)).toHaveLength(2);
      expect(h.auth.state().clock_skew_ms, String(skew)).toBe(skew);
      await stopFakeServers();
    }
  });

  it("F4f (M21): en server hvis Date-header hopper mellom +15 og -15 min gir MAKS én umiddelbar gjentakelse - deretter AUTH_FAILED (ingen uendelig retry-sløyfe)", async () => {
    let requests = 0;
    // De seks første forespørslene alternerer; deretter stabil klokke - så en regresjon (ubegrenset gjentakelse) ender i en feilet påstand, ikke en hengende test.
    const h = await harness({ serverNow: (clockNow) => { requests += 1; return requests > 6 ? clockNow : clockNow + (requests % 2 === 1 ? 900_000 : -900_000); } });
    const error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_AUTH_FAILED");
    expect(h.fake.mintRequests()).toHaveLength(2); // første forsøk + nøyaktig ÉN gjentakelse
    expect(h.sleeps).toEqual([]);
  });

  it("F4g (M41): nøkkelstørrelsen har både nedre (2048) og øvre (16384) grense - kantene prøves med bygde ASN.1-nøkler (ikke ekte nøkkelpar)", () => {
    const reason = (bits: number): string | null => {
      try {
        parseGitHubAppPrivateKey(fakeRsaPrivateKeyPem(bits));
        return null;
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubAppAuthError);
        return (err as GitHubAppAuthError).message;
      }
    };
    expect(reason(2047)).toContain("too_small");
    expect(reason(2048)).toBeNull();
    expect(reason(4096)).toBeNull();
    expect(reason(16_384)).toBeNull();
    expect(reason(16_385)).toContain("too_large");
    expect(reason(20_000)).toContain("too_large");
    expect(parseGitHubAppPrivateKey(fakeRsaPrivateKeyPem(16_384)).asymmetricKeyDetails?.modulusLength).toBe(16_384);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F3a: statuspoll, helse-sveip og «er X konfigurert» utsteder ALDRI et installasjonstoken (hasSecret -> SecretProvider.has)", () => {
  const TOKEN_REF = "JARVIS_GITHUB_TOKEN";
  const KEY_REF = "JARVIS_GITHUB_APP_PRIVATE_KEY";
  const PAT = "pat-skal-bare-vaere-synlig-med-fallback-0123456789";

  class CountingSecrets implements SecretProvider {
    readonly name = "counting";
    readonly gets: string[] = [];
    constructor(readonly values: Record<string, string>) {}
    async get(ref: string): Promise<string | null> { this.gets.push(ref); return this.values[ref] ?? null; }
  }

  async function appMode(extraEnv: Record<string, string> = {}, values: Record<string, string> = { [KEY_REF]: keys.pkcs1 }) {
    const fake = await FakeGitHubApp.start({ publicKey: keys.publicKey, appId: APP_ID, installationId: INSTALLATION_ID });
    const secrets = new CountingSecrets(values);
    const auth = createGitHubAuth({
      secrets, allowLoopbackHttpForTests: true, sleep: async () => undefined, maxAttempts: 1, log: () => undefined,
      env: { JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO, JARVIS_GITHUB_API_BASE: fake.baseUrl, ...extraEnv }
    });
    return { fake, secrets, auth, provider: auth.secretProvider(secrets), stop: () => fake.stop() };
  }

  it("F3a1: has() på token-refen er en LOKAL sjekk (konfig + brukbar nøkkel i vaulten) - null forespørsler mot GitHub, uansett hvor mange ganger den kalles", async () => {
    const m = await appMode();
    try {
      for (let i = 0; i < 25; i += 1) expect(await m.provider.has?.(TOKEN_REF)).toBe(true);
      expect(m.fake.requests).toHaveLength(0);
      expect(m.auth.status().state).toBe("app_pending"); // ingenting utstedt, ingenting forgiftet
      expect(m.auth.knownTokens()).toEqual([]);
    } finally {
      await m.stop();
    }
  });

  it("F3a2: has() er false uten brukbar oppsett: nøkkel mangler/er søppel, ugyldig konfig - og true igjen når eieren retter det (ingen mellomlagret nei)", async () => {
    const noKey = await appMode({}, {});
    try {
      expect(await noKey.provider.has?.(TOKEN_REF)).toBe(false);
      noKey.secrets.values[KEY_REF] = "dette er ikke en nøkkel";
      expect(await noKey.provider.has?.(TOKEN_REF)).toBe(false);
      noKey.secrets.values[KEY_REF] = keys.pkcs1;
      expect(await noKey.provider.has?.(TOKEN_REF)).toBe(true);
      expect(noKey.fake.requests).toHaveLength(0);
    } finally {
      await noKey.stop();
    }
    const invalid = await appMode({ JARVIS_GITHUB_APP_INSTALLATION_ID: "" });
    try {
      expect(await invalid.provider.has?.(TOKEN_REF)).toBe(false);
      expect(invalid.fake.requests).toHaveLength(0);
    } finally {
      await invalid.stop();
    }
  });

  it("F3a3: PAT teller som «konfigurert» i App-modus KUN når eieren eksplisitt har tillatt fallback (ellers kan Jarvis aldri bruke den)", async () => {
    const values = { [TOKEN_REF]: PAT };
    const without = await appMode({}, values);
    const withFallback = await appMode({ JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" }, values);
    const withFallbackNoPat = await appMode({ JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" }, {});
    try {
      expect(await without.provider.has?.(TOKEN_REF)).toBe(false);
      expect(await withFallback.provider.has?.(TOKEN_REF)).toBe(true);
      expect(await withFallbackNoPat.provider.has?.(TOKEN_REF)).toBe(false);
      for (const m of [without, withFallback, withFallbackNoPat]) expect(m.fake.requests).toHaveLength(0);
    } finally {
      await Promise.all([without.stop(), withFallback.stop(), withFallbackNoPat.stop()]);
    }
  });

  it("F3a4: andre refer forvaltes av inner (get/has uendret); PAT-modus er uendret (secretProvider(inner) er inner, hasSecret bruker get)", async () => {
    const m = await appMode();
    try {
      m.secrets.values["ANNEN_REF"] = "verdi";
      expect(await m.provider.has?.("ANNEN_REF")).toBe(true);
      expect(await m.provider.has?.("FINNES_IKKE")).toBe(false);
    } finally {
      await m.stop();
    }
    const secrets = new CountingSecrets({ [TOKEN_REF]: PAT });
    const pat = createGitHubAuth({ secrets, env: {}, log: () => undefined });
    expect(pat.secretProvider(secrets)).toBe(secrets);
    expect((secrets as SecretProvider).has).toBeUndefined();
    const gateway = new ToolGateway({} as never, {} as never, secrets);
    expect(await gateway.hasSecret(TOKEN_REF)).toBe(true);
    expect(await gateway.hasSecret("FINNES_IKKE")).toBe(false);
  });

  it("F3a5: ToolGateway.hasSecret bruker has() når leverandøren har den (get() kalles aldri), faller tilbake til get(), og en has() som kaster gir false", async () => {
    const calls: string[] = [];
    const withHas: SecretProvider = { name: "x", get: async (ref) => { calls.push(`get:${ref}`); return "hemmelig"; }, has: async (ref) => { calls.push(`has:${ref}`); return ref === "A"; } };
    const gateway = new ToolGateway({} as never, {} as never, withHas);
    expect(await gateway.hasSecret("A")).toBe(true);
    expect(await gateway.hasSecret("B")).toBe(false);
    expect(calls).toEqual(["has:A", "has:B"]);
    const throwing = new ToolGateway({} as never, {} as never, { name: "y", get: async () => "v", has: async () => { throw new Error("nede"); } });
    expect(await throwing.hasSecret("A")).toBe(false);
  });

  it("F3a6: listConnectorStatus (dashbord/get_connector_status) polles 40 ganger uten at ett eneste token utstedes - GitHub er likevel «konfigurert», og tilbakekalling/kill switch kan ikke omgås via polling", async () => {
    const m = await appMode();
    try {
      const gateway = new ToolGateway({} as never, {} as never, m.provider);
      for (let i = 0; i < 40; i += 1) {
        const github = (await listConnectorStatus(gateway, { authInfo: (id) => (id === "github" ? m.auth.connectorAuthInfo() : undefined) })).find((c) => c.id === "github");
        expect(github?.configured).toBe(true);
        expect(github?.optional_credentials).toEqual([{ ref: KEY_REF, configured: true }]);
        expect(github?.auth?.detail["state"]).toBe("app_pending");
      }
      expect(m.fake.requests).toHaveLength(0); // før rettelsen: ett POST access_tokens per poll
      expect(m.secrets.gets.filter((ref) => ref === TOKEN_REF)).toEqual([]); // token-refen ble aldri materialisert
    } finally {
      await m.stop();
    }
  });

  it("F3a7: en hengende GitHub blokkerer aldri statuspollen (den kontakter ikke GitHub)", async () => {
    const m = await appMode();
    try {
      m.fake.script = [{ hang: true }, { hang: true }, { hang: true }];
      const gateway = new ToolGateway({} as never, {} as never, m.provider);
      const started = performance.now();
      await listConnectorStatus(gateway);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(m.fake.requests).toHaveLength(0);
    } finally {
      await m.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F10: .gitignore fanger GitHub App-privatnøkkelen uansett filnavn (*.pem), men aldri den OFFENTLIGE konstitusjonsnøkkelen", () => {
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  // Den virkelige git-semantikken (`--no-index`: uavhengig av om filen er sporet), ikke bare tekstmønstre. Statuser utenom 0/1 er en ødelagt testrigg, ikke et «ikke ignorert».
  const ignored = (path: string): boolean => {
    const result = spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: ROOT });
    if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore feilet (${String(result.status)}): ${String(result.stderr)}`);
    return result.status === 0;
  };

  it("F10a: nøkkelfiler med eierens eget navn (runbookens nokkel.pem), GitHubs standardnavn og dype stier er ignorert", () => {
    for (const path of ["nokkel.pem", "jarvis-app.2026-10-09.private-key.pem", "keys/app.pem", "a/b/c/hva-som-helst.pem", "backup/app-key.pem"]) {
      expect(ignored(path), path).toBe(true);
    }
  });

  it("F10b: den OFFENTLIGE konstitusjonsnøkkelen (og signaturen) kan fortsatt committes - eksplisitt unntak, ikke et hull for andre .pem", () => {
    expect(ignored("config/evolution/constitution.pub.pem")).toBe(false);
    expect(ignored("config/evolution/constitution.v1.sig")).toBe(false);
    expect(ignored("config/evolution/constitution.pem")).toBe(true); // unntaket gjelder KUN den ene eksakte stien
    expect(ignored("other/dir/constitution.pub.pem")).toBe(true);
  });

  it("F10c: runbooken sier hva som ignoreres, og eksempelfilnavnet i runbooken er dekket av regelen", () => {
    const gitignore = readFileSync(`${ROOT}.gitignore`, "utf8");
    expect(gitignore).toMatch(/^\*\.pem$/m);
    const runbook = readFileSync(`${ROOT}docs/runbooks/GITHUB_APP.md`, "utf8");
    expect(runbook).toContain("./nokkel.pem");
    expect(ignored("nokkel.pem")).toBe(true);
    expect(runbook).toMatch(/\.gitignore/);
  });
});
