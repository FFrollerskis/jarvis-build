import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { GitCredentialSource } from "@jarvis/contracts";
import { GitHubAppAuthError, type GitHubAuthLogEvent } from "../src/github-app-auth.ts";
import { CONNECTOR_REGISTRY, listConnectorStatus } from "../src/connector-registry.ts";
import type { SecretProvider } from "../src/gateway.ts";
import { GithubRateLimitController, InMemoryGithubRateLimitStore } from "../src/github-rate-limit-controller.ts";
import {
  GITHUB_FULL_CAPABILITY_PERMISSIONS, GITHUB_TOKEN_REF, GitHubTokenSecretProvider, PatTokenProvider, createGitHubAuth, resolveGitHubAuthSettings,
  type GitHubAuth, type GitHubTokenProvider
} from "../src/github-token-provider.ts";
import { FakeGitHubApp, testKeys, type ScriptedResponse } from "./support/fake-github-app.ts";

/**
 * WP-C3: `GitHubTokenProvider` (PAT / App), `SecretProvider`-dekoratøren, PAT-fallback-policy, `GitCredentialSource`, rate-limit-nøkkel og
 * connector-/EV-17-metadata. Alt mot lokal fake GitHub (127.0.0.1) - ingen eksterne kall.
 */

const APP_ID = "123456";
const INSTALLATION_ID = "9876543";
const REPO = "tsworkflow/jarvisbuild";
const T0 = Date.parse("2026-10-09T12:00:00Z");
const PAT = "pat-value-that-must-never-leak-0123456789";
const keys = testKeys();
const servers: FakeGitHubApp[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
});

class MapSecrets implements SecretProvider {
  readonly name = "map";
  readonly reads: string[] = [];
  constructor(readonly values: Record<string, string>) {}
  async get(ref: string): Promise<string | null> {
    this.reads.push(ref);
    return this.values[ref] ?? null;
  }
}

interface Setup {
  readonly fake: FakeGitHubApp;
  readonly clock: { t: number };
  readonly logs: GitHubAuthLogEvent[];
  readonly secrets: MapSecrets;
  readonly auth: GitHubAuth;
}

async function setup(options: { env?: Record<string, string>; secrets?: Record<string, string>; withoutKey?: boolean } = {}): Promise<Setup> {
  const clock = { t: T0 };
  const fake = await FakeGitHubApp.start({ publicKey: keys.publicKey, appId: APP_ID, installationId: INSTALLATION_ID, serverNow: () => clock.t });
  servers.push(fake);
  const logs: GitHubAuthLogEvent[] = [];
  const secrets = new MapSecrets({
    [GITHUB_TOKEN_REF]: PAT,
    ...(options.withoutKey ? {} : { JARVIS_GITHUB_APP_PRIVATE_KEY: keys.pkcs1 }),
    JARVIS_OTHER_SECRET: "andre-verdi",
    ...options.secrets
  });
  const env = {
    JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO, JARVIS_GITHUB_API_BASE: fake.baseUrl,
    ...options.env
  };
  const auth = createGitHubAuth({
    secrets, env, allowLoopbackHttpForTests: true, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, random: () => 0.5, log: (e) => { logs.push(e); }
  });
  return { fake, clock, logs, secrets, auth };
}

function patSetup(): { auth: GitHubAuth; logs: GitHubAuthLogEvent[]; secrets: MapSecrets } {
  const logs: GitHubAuthLogEvent[] = [];
  const secrets = new MapSecrets({ [GITHUB_TOKEN_REF]: PAT });
  return { auth: createGitHubAuth({ secrets, env: {}, log: (e) => { logs.push(e); } }), logs, secrets };
}

// ---------------------------------------------------------------------------------------------------------------------------------
describe("A: valg av metode fra miljøet - ingen konfig = PAT som i dag; delvis/ugyldig App-konfig = høylytt feil (aldri stille PAT)", () => {
  const base = { JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO };

  it("A1: verken App-id eller installasjons-id (også blanke/whitespace) -> kind pat", () => {
    expect(resolveGitHubAuthSettings({}).kind).toBe("pat");
    expect(resolveGitHubAuthSettings({ JARVIS_GITHUB_APP_ID: "", JARVIS_GITHUB_APP_INSTALLATION_ID: "   " }).kind).toBe("pat");
    expect(resolveGitHubAuthSettings({ JARVIS_GITHUB_TOKEN: "x", JARVIS_GITHUB_REPO: REPO, JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" }).kind).toBe("pat");
  });

  it("A2: gyldig konfig -> kind app med repo-scope fra JARVIS_GIT_ALLOWED_REPOS (foretrukket) ellers JARVIS_GITHUB_REPO", () => {
    expect(resolveGitHubAuthSettings(base)).toMatchObject({ kind: "app", appId: APP_ID, installationId: INSTALLATION_ID, apiBase: "https://api.github.com", repositories: [REPO], allowPatFallback: false });
    const multi = resolveGitHubAuthSettings({ ...base, JARVIS_GIT_ALLOWED_REPOS: "tsworkflow/a, tsworkflow/b" });
    expect(multi).toMatchObject({ kind: "app", repositories: ["tsworkflow/a", "tsworkflow/b"] });
  });

  it("A3: kun én av id-ene, ugyldige id-er, ingen repo-scope, ugyldig repo-liste -> kind invalid med presis kode (IKKE pat)", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_REPO: REPO }, "JARVIS_GITHUB_APP_INSTALLATION_ID_missing"],
      [{ JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO }, "JARVIS_GITHUB_APP_ID_missing"],
      [{ ...base, JARVIS_GITHUB_APP_ID: "a b" }, "app_id_invalid"],
      [{ ...base, JARVIS_GITHUB_APP_INSTALLATION_ID: "12ab" }, "installation_id_invalid"],
      [{ JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID }, "set_JARVIS_GITHUB_REPO"],
      [{ ...base, JARVIS_GITHUB_REPO: "bare-navn" }, "allowed_repos_invalid"],
      [{ ...base, JARVIS_GIT_ALLOWED_REPOS: "../x/y" }, "allowed_repos_invalid"]
    ];
    for (const [env, detail] of cases) {
      const settings = resolveGitHubAuthSettings(env);
      expect(settings.kind, detail).toBe("invalid");
      if (settings.kind === "invalid") {
        expect(settings.error).toBeInstanceOf(GitHubAppAuthError);
        expect(settings.error.message, detail).toContain(detail);
      }
    }
    const noScope = resolveGitHubAuthSettings({ JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID });
    expect(noScope.kind === "invalid" && noScope.error.code).toBe("GITHUB_APP_SCOPE_UNDEFINED");
  });

  it("A4: JARVIS_GITHUB_API_BASE er alltid https://api.github.com - ingen annen vert (review F5), og loopback-http kan IKKE slås på fra miljøet, kun via testflagget i koden", () => {
    for (const bad of ["http://127.0.0.1:4010", "http://api.github.com", "https://localhost", "https://10.0.0.5", "ftp://x.y.z", "https://ghe.firma.no/api/v3", "https://evil.example"]) {
      const settings = resolveGitHubAuthSettings({ ...base, JARVIS_GITHUB_API_BASE: bad });
      expect(settings.kind, bad).toBe("invalid");
    }
    expect(resolveGitHubAuthSettings({ ...base, JARVIS_GITHUB_API_BASE: "http://127.0.0.1:4010" }, { allowLoopbackHttpForTests: true }).kind).toBe("app");
    expect(resolveGitHubAuthSettings({ ...base, JARVIS_GITHUB_API_BASE: "https://api.github.com" }).kind).toBe("app");
    expect(resolveGitHubAuthSettings({ ...base, JARVIS_GITHUB_API_BASE: "" }).kind).toBe("app");
  });

  it("A5: PAT-fallback er AV som standard og slås kun på av eksakt «true» (små bokstaver, ingen mellomrom - review F6) - «TRUE»/«1»/«yes»/«on» teller ikke", () => {
    for (const [value, expected] of [[undefined, false], ["", false], ["false", false], ["1", false], ["yes", false], ["on", false], ["TRUE", false], ["True", false], [" true ", false], ["true", true]] as const) {
      const settings = resolveGitHubAuthSettings({ ...base, ...(value === undefined ? {} : { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: value }) });
      expect(settings.kind === "app" && settings.allowPatFallback, String(value)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("B: PAT-modus er BYTE-FOR-BYTE uendret", () => {
  it("B1: secretProvider(inner) returnerer inner selv (ingen dekoratør), og PAT leses som før; ingen oppstartslogg", async () => {
    const { auth, logs, secrets } = patSetup();
    expect(auth.method).toBe("pat");
    const provider = auth.secretProvider(secrets);
    expect(provider).toBe(secrets);
    expect(await provider.get(GITHUB_TOKEN_REF)).toBe(PAT);
    expect(logs).toEqual([]);
  });

  it("B2: status/metadata for PAT: ikke kortlevd, ikke repo-scopet, ikke «hardened»; rate-limit-nøkkel og -kontroller som før", () => {
    const { auth } = patSetup();
    expect(auth.status()).toMatchObject({ method: "pat", state: "pat", short_lived: false, scoped: false, hardened: false, app: null, pat_fallback: { allowed: false, active: false } });
    expect(auth.connectorAuthInfo()).toMatchObject({ method: "pat", short_lived: false, scoped: false });
    expect(auth.rateLimitScopeRef()).toBe("JARVIS_GITHUB_TOKEN");
    const controller = auth.rateLimitController(new InMemoryGithubRateLimitStore());
    expect(Object.getPrototypeOf(controller)).toBe(GithubRateLimitController.prototype);
    expect(auth.knownTokens()).toEqual([]);
    expect(auth.credentialFacts()).toMatchObject({ kind: "api_key", auth_method: "pat", short_lived: false, repo_scoped: false, scopes_granted: [], scopes_required: [] });
  });

  it("B3: gitCredentialSource i PAT-modus gir PAT-en (som coding.ts i dag); uten PAT kastes GITHUB_TOKEN_UNAVAILABLE; ugyldig slug avvises", async () => {
    const { auth } = patSetup();
    const source: GitCredentialSource = auth.gitCredentialSource();
    expect(await source.tokenFor(REPO)).toBe(PAT);
    const empty = createGitHubAuth({ secrets: new MapSecrets({}), env: {}, log: () => undefined });
    await expect(empty.gitCredentialSource().tokenFor(REPO)).rejects.toMatchObject({ code: "GITHUB_TOKEN_UNAVAILABLE" });
    for (const bad of ["../x/y", "https://github.com/a/b", "a/b/c", "", "x"]) {
      await expect(auth.gitCredentialSource().tokenFor(bad), bad).rejects.toMatchObject({ code: "GITHUB_APP_CONFIG_INVALID" });
    }
  });

  it("B4: PatTokenProvider og GitHubTokenSecretProvider følger SecretProvider-kontrakten (get kaster aldri)", async () => {
    const throwing: GitHubTokenProvider = {
      method: "app", getToken: async () => { throw new Error("boom"); }, hasCredential: async () => { throw new Error("boom"); }, describe: () => { throw new Error("n/a"); }
    };
    const decorated = new GitHubTokenSecretProvider(new MapSecrets({ A: "a" }), throwing);
    expect(await decorated.get(GITHUB_TOKEN_REF)).toBeNull();
    expect(await decorated.has(GITHUB_TOKEN_REF)).toBe(false); // has() kaster heller aldri
    expect(await decorated.get("A")).toBe("a");
    expect(await decorated.has("A")).toBe(true);
    expect(await decorated.has("FINNES_IKKE")).toBe(false);
    expect(await new PatTokenProvider(new MapSecrets({ [GITHUB_TOKEN_REF]: PAT })).getToken()).toBe(PAT);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("C: App-modus - installasjonstoken under SAMME ref, øvrige refer uendret, ingen stille nedgradering", () => {
  it("C1: get(JARVIS_GITHUB_TOKEN) gir repo-scopet installasjonstoken (ikke PAT-en); andre refer går til inner; oppstartslogg uten hemmeligheter", async () => {
    const s = await setup();
    const provider = s.auth.secretProvider(s.secrets);
    expect(provider).not.toBe(s.secrets);
    const token = await provider.get(GITHUB_TOKEN_REF);
    expect(token).toMatch(/^ghs_/);
    expect(token).not.toBe(PAT);
    expect(await provider.get("JARVIS_OTHER_SECRET")).toBe("andre-verdi");
    expect(JSON.parse(s.fake.mintRequests()[0]?.body ?? "{}")).toEqual({ repositories: ["jarvisbuild"] });
    expect(s.secrets.reads).not.toContain(GITHUB_TOKEN_REF); // PAT-en ble ikke engang lest
    const started = s.logs.find((l) => l.msg === "github_auth_mode");
    expect(started).toMatchObject({ method: "app", app_id: APP_ID, installation_id: INSTALLATION_ID, repositories: REPO, pat_fallback_allowed: false });
    expect(JSON.stringify(s.logs)).not.toContain(PAT);
  });

  it("C2: privatnøkkelen leses fra SecretProvider (vaulten) ved utstedelse - aldri fra miljøvariabelen i env", async () => {
    const s = await setup({ env: { JARVIS_GITHUB_APP_PRIVATE_KEY: "denne-skal-ignoreres" } });
    await s.auth.secretProvider(s.secrets).get(GITHUB_TOKEN_REF);
    expect(s.secrets.reads).toContain("JARVIS_GITHUB_APP_PRIVATE_KEY");
    expect(s.fake.mintRequests()[0]?.jwtProblems).toEqual([]);
  });

  it("C3: feiler utstedelsen UTEN fallback: get gir null (ikke kast), PAT-en brukes ALDRI, feilen er høylytt (logg) og synlig i status", async () => {
    const s = await setup();
    s.fake.script = [{ status: 401, json: { message: "Bad credentials" } }];
    const provider = s.auth.secretProvider(s.secrets);
    expect(await provider.get(GITHUB_TOKEN_REF)).toBeNull();
    expect(s.secrets.reads).not.toContain(GITHUB_TOKEN_REF);
    const failed = s.logs.find((l) => l.msg === "github_app_auth_failed");
    expect(failed).toMatchObject({ level: "error", code: "GITHUB_APP_AUTH_FAILED", http_status: 401 });
    const status = s.auth.status();
    expect(status).toMatchObject({ method: "app", state: "app_error", short_lived: false, scoped: false, hardened: false });
    expect(status.app?.last_error?.code).toBe("GITHUB_APP_AUTH_FAILED");
    expect(status.pat_fallback).toEqual({ allowed: false, active: false });
  });

  it("C4: ugyldig/delvis konfig (manglende installasjons-id) -> App-modus feiler lukket og høylytt; PAT brukes ikke", async () => {
    const s = await setup({ env: { JARVIS_GITHUB_APP_INSTALLATION_ID: "" } });
    expect(s.auth.method).toBe("app");
    expect(s.auth.settings.kind).toBe("invalid");
    expect(s.logs.find((l) => l.msg === "github_app_config_invalid")).toMatchObject({ level: "error", code: "GITHUB_APP_CONFIG_INVALID" });
    const provider = s.auth.secretProvider(s.secrets);
    expect(await provider.get(GITHUB_TOKEN_REF)).toBeNull();
    expect(s.fake.requests).toHaveLength(0);
    expect(s.secrets.reads).not.toContain(GITHUB_TOKEN_REF);
    expect(s.logs.some((l) => l.msg === "github_app_unusable" && l.code === "GITHUB_APP_CONFIG_INVALID")).toBe(true);
    expect(s.auth.status()).toMatchObject({ state: "app_error", hardened: false });
    expect(s.auth.status().app?.last_error?.code).toBe("GITHUB_APP_CONFIG_INVALID");
  });

  it("C5: nøkkelen mangler i vaulten -> KEY_MISSING i status (ikke PAT); lim inn nøkkelen -> neste kall virker umiddelbart", async () => {
    const s = await setup({ withoutKey: true });
    const provider = s.auth.secretProvider(s.secrets);
    expect(await provider.get(GITHUB_TOKEN_REF)).toBeNull();
    expect(s.auth.status().app?.last_error?.code).toBe("GITHUB_APP_KEY_MISSING");
    s.secrets.values["JARVIS_GITHUB_APP_PRIVATE_KEY"] = keys.pkcs1;
    expect(await provider.get(GITHUB_TOKEN_REF)).toMatch(/^ghs_/);
    expect(s.auth.status().state).toBe("app_ok");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("D: eksplisitt, loggført PAT-fallback (JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK=true)", () => {
  it("D1: feilet utstedelse + fallback på -> PAT leveres, bruken loggføres (warn, ratebegrenset - se D5) og er synlig i status; ikke lenger «hardened»", async () => {
    const s = await setup({ env: { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" } });
    s.fake.script = [{ status: 403, json: { message: "Resource not accessible by integration" } }];
    const provider = s.auth.secretProvider(s.secrets);
    expect(await provider.get(GITHUB_TOKEN_REF)).toBe(PAT);
    const warn = s.logs.find((l) => l.msg === "github_app_pat_fallback_used");
    expect(warn).toMatchObject({ level: "warn", code: "GITHUB_APP_FORBIDDEN", http_status: 403 });
    expect(JSON.stringify(s.logs)).not.toContain(PAT);
    const status = s.auth.status();
    expect(status.pat_fallback).toEqual({ allowed: true, active: true });
    expect(status).toMatchObject({ state: "app_error", short_lived: false, scoped: false, hardened: false });
    expect(s.auth.credentialFacts()).toMatchObject({ kind: "api_key", short_lived: false, repo_scoped: false, expires_at: null });
    // Når App-en virker igjen, forlates fallbacken automatisk.
    s.clock.t += 60_000;
    expect(await provider.get(GITHUB_TOKEN_REF)).toMatch(/^ghs_/);
    expect(s.auth.status().pat_fallback.active).toBe(false);
    expect(s.auth.status().state).toBe("app_ok");
  });

  it("D5 (review F7): loggføringen er RATEBEGRENSET, ikke «hver bruk» - 25 fallback-bruk innenfor ett minutt gir nøyaktig én logglinje, neste minutt en ny; statusen viser aktiv hele tiden", async () => {
    // Nøkkelen mangler i vaulten: en vedvarende, lokal feil (ingen nettverkskall, ingen ventetid) - hver `get` faller tilbake til PAT-en.
    const s = await setup({ env: { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" }, withoutKey: true });
    const provider = s.auth.secretProvider(s.secrets);
    const fallbackLines = (): number => s.logs.filter((l) => l.msg === "github_app_pat_fallback_used").length;
    for (let i = 0; i < 25; i += 1) {
      expect(await provider.get(GITHUB_TOKEN_REF)).toBe(PAT);
      s.clock.t += 1_000; // 25 bruk fordelt over 25 sekunder (alle innenfor ett minutt)
      expect(s.auth.status().pat_fallback.active).toBe(true);
    }
    expect(fallbackLines()).toBe(1);
    s.clock.t += 40_000; // > 60 s siden første linje
    expect(await provider.get(GITHUB_TOKEN_REF)).toBe(PAT);
    expect(fallbackLines()).toBe(2);
    expect(JSON.stringify(s.logs)).not.toContain(PAT);
  });

  it("D2: fallback på, men ingen PAT finnes -> fortsatt null (ingenting å falle tilbake til), ikke «aktiv»", async () => {
    const s = await setup({ env: { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" }, secrets: { [GITHUB_TOKEN_REF]: "" } });
    s.fake.script = [{ status: 404, json: { message: "Not Found" } }];
    expect(await s.auth.secretProvider(s.secrets).get(GITHUB_TOKEN_REF)).toBeNull();
    expect(s.auth.status().pat_fallback).toEqual({ allowed: true, active: false });
  });

  it("D3: ALDRI fallback når leverandøren ga noe annet enn forespurt (SCOPE_MISMATCH) - selv med fallback på", async () => {
    const s = await setup({ env: { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" } });
    s.fake.script = [{ status: 201, build: () => ({ status: 201, json: { ...s.fake.buildTokenBody({ repositories: ["jarvisbuild"] }), repository_selection: "all", repositories: undefined } }) }];
    expect(await s.auth.secretProvider(s.secrets).get(GITHUB_TOKEN_REF)).toBeNull();
    expect(s.auth.status().app?.last_error?.code).toBe("GITHUB_APP_SCOPE_MISMATCH");
    expect(s.auth.status().pat_fallback.active).toBe(false);
  });

  it("D4: ugyldig App-konfig + fallback på -> PAT leveres med loggføring (migreringsscenariet), uten fallback -> null", async () => {
    const s = await setup({ env: { JARVIS_GITHUB_APP_INSTALLATION_ID: "", JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" } });
    expect(await s.auth.secretProvider(s.secrets).get(GITHUB_TOKEN_REF)).toBe(PAT);
    expect(s.logs.some((l) => l.msg === "github_app_pat_fallback_used" && l.code === "GITHUB_APP_CONFIG_INVALID")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("E: GitCredentialSource - repo-scopet token til git clone/push (kontrakten WP-C1 bruker)", () => {
  it("E1: tokenFor(slug) utsteder et token scopet til NØYAKTIG det ene repoet (ikke hele standardlisten) og med MINSTE rettighet (contents:write - review F2), cachet per repo", async () => {
    const s = await setup({ env: { JARVIS_GIT_ALLOWED_REPOS: "tsworkflow/jarvisbuild,tsworkflow/other-repo" } });
    const source: GitCredentialSource = s.auth.gitCredentialSource();
    const a = await source.tokenFor("tsworkflow/jarvisbuild");
    expect(JSON.parse(s.fake.mintRequests()[0]?.body ?? "{}")).toEqual({ repositories: ["jarvisbuild"], permissions: { contents: "write" } });
    expect(await source.tokenFor("TSWORKFLOW/JarvisBuild")).toBe(a);
    const b = await source.tokenFor("tsworkflow/other-repo");
    expect(b).not.toBe(a);
    expect(s.fake.mintRequests()).toHaveLength(2);
    expect(s.fake.issued.get(a)?.repos).toEqual(["jarvisbuild"]);
    // Standard-scope (connector) er hele listen - et eget token, ikke det repo-spesifikke.
    const connectorToken = await s.auth.secretProvider(s.secrets).get(GITHUB_TOKEN_REF);
    expect(s.fake.issued.get(connectorToken ?? "")?.repos).toEqual(["jarvisbuild", "other-repo"]);
  });

  it("E2: repo utenfor den konfigurerte listen får ALDRI token (SCOPE_MISMATCH) - ingen nettverkskall, ingen PAT-fallback selv om den er på", async () => {
    const s = await setup({ env: { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" } });
    await expect(s.auth.gitCredentialSource().tokenFor("tsworkflow/other-repo")).rejects.toMatchObject({ code: "GITHUB_APP_SCOPE_MISMATCH" });
    await expect(s.auth.gitCredentialSource().tokenFor("fremmed/jarvisbuild")).rejects.toMatchObject({ code: "GITHUB_APP_SCOPE_MISMATCH" });
    expect(s.fake.requests).toHaveLength(0);
    expect(s.auth.status().pat_fallback.active).toBe(false);
  });

  it("E3: ugyldige slugs (path traversal, URL, flere segmenter, kontrolltegn) avvises før noe annet skjer", async () => {
    const s = await setup();
    for (const bad of ["../x/y", "tsworkflow/../x", "https://github.com/tsworkflow/jarvisbuild", "tsworkflow/jarvisbuild/extra", "tsworkflow/jarvis build", "tsworkflow/jarvisbuild\n", "", "tsworkflow"]) {
      await expect(s.auth.gitCredentialSource().tokenFor(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: "GITHUB_APP_CONFIG_INVALID" });
    }
    expect(s.fake.requests).toHaveLength(0);
  });

  it("E4: utstedelsesfeil kastes (aldri tom streng); med eksplisitt fallback leveres PAT-en loggført", async () => {
    let s = await setup();
    s.fake.script = [{ status: 404, json: { message: "Not Found" } }];
    await expect(s.auth.gitCredentialSource().tokenFor(REPO)).rejects.toMatchObject({ code: "GITHUB_APP_INSTALLATION_NOT_FOUND" });
    s = await setup({ env: { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" } });
    s.fake.script = [{ status: 404, json: { message: "Not Found" } }];
    expect(await s.auth.gitCredentialSource().tokenFor(REPO)).toBe(PAT);
    expect(s.logs.some((l) => l.msg === "github_app_pat_fallback_used")).toBe(true);
  });

  it("E5: PAT-kilden for fallback kan overstyres (worker: env-kilden), mens nøkkelen alltid leses fra hovedkilden (vaulten)", async () => {
    const s = await setup({ env: { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" } });
    const envOnly = new MapSecrets({ [GITHUB_TOKEN_REF]: "env-pat-123456789" });
    s.fake.script = [{ status: 404 }];
    expect(await s.auth.gitCredentialSource(envOnly).tokenFor(REPO)).toBe("env-pat-123456789");
    expect(envOnly.reads).toEqual([GITHUB_TOKEN_REF]);
    expect(s.secrets.reads).toContain("JARVIS_GITHUB_APP_PRIVATE_KEY");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F: rate-limit-nøkkel og 401-håndtering - installasjonstoken har egen kvote", () => {
  it("F1: nøkkelen er per installasjon (arver ikke PAT-ens cooldown); kontrolleren virker som før (cooldown håndheves, rene tilstander)", async () => {
    const s = await setup();
    expect(s.auth.rateLimitScopeRef()).toBe(`JARVIS_GITHUB_APP_INSTALLATION_${INSTALLATION_ID}`);
    const store = new InMemoryGithubRateLimitStore();
    // PAT-ens gamle cooldown ligger under den gamle nøkkelen og skal ikke blokkere App-kall.
    await new GithubRateLimitController(store, "JARVIS_GITHUB_TOKEN").recordOutcome(false, 429, { get: (n) => (n === "retry-after" ? "3600" : null) }, "");
    const controller = s.auth.rateLimitController(store);
    expect(await controller.checkEligible(true)).toEqual({ eligible: true });
    await controller.recordOutcome(true, 429, { get: (n) => (n === "retry-after" ? "60" : null) }, "");
    const blocked = await controller.checkEligible(true);
    expect(blocked.eligible).toBe(false);
  });

  it("F2: et 401 fra GitHub (revokert/ugyldiggjort installasjonstoken) får cachen til å slippe tokenet slik at neste kall utsteder et nytt", async () => {
    const s = await setup();
    const provider = s.auth.secretProvider(s.secrets);
    const first = await provider.get(GITHUB_TOKEN_REF);
    const controller = s.auth.rateLimitController(new InMemoryGithubRateLimitStore());
    s.clock.t += 20_000;
    expect(await controller.recordOutcome(false, 401, { get: () => null }, "{\"message\":\"Bad credentials\"}")).toEqual({ kind: "OTHER" });
    const second = await provider.get(GITHUB_TOKEN_REF);
    expect(second).not.toBe(first);
    expect(s.fake.mintRequests()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("G: connector-status, EV-17-fakta og redaksjon", () => {
  it("G1: connectorAuthInfo() viser metode, installasjons-id, utløp, repo-scope og tildelte rettigheter - aldri tokenet; «kortlevd repo-scopet identitet: ja»", async () => {
    const s = await setup();
    const provider = s.auth.secretProvider(s.secrets);
    expect(s.auth.status()).toMatchObject({ state: "app_pending", short_lived: false, scoped: false, hardened: false }); // review F9: ikke bevist før første utstedelse
    const token = (await provider.get(GITHUB_TOKEN_REF)) ?? "";
    const info = s.auth.connectorAuthInfo();
    expect(info).toMatchObject({ method: "app", short_lived: true, scoped: true });
    expect(info.detail).toMatchObject({
      state: "app_ok", hardened: true, app_id: APP_ID, installation_id: INSTALLATION_ID, repositories: [REPO], repository_selection: "selected",
      token_expires_at: new Date(T0 + 3_600_000).toISOString(), pat_fallback_allowed: false, pat_fallback_active: false, last_error: null
    });
    expect((info.detail["permissions"] as Record<string, string>)["contents"]).toBe("write");
    const serialized = JSON.stringify(info) + JSON.stringify(s.auth.status()) + inspect(s.auth, { depth: 8 });
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(PAT);
    expect(serialized).not.toContain("PRIVATE KEY");
  });

  it("G2: listConnectorStatus({authInfo}) legger auth KUN på github; PAT-ref alene gjør GitHub «konfigurert»; privatnøkkel-refen er valgfri og teller ikke med", async () => {
    const s = await setup();
    const gateway = { hasSecret: async (ref: string) => ref === GITHUB_TOKEN_REF, health: new Map() };
    const statuses = await listConnectorStatus(gateway, { authInfo: (id) => (id === "github" ? s.auth.connectorAuthInfo() : undefined) });
    const github = statuses.find((c) => c.id === "github");
    expect(github?.configured).toBe(true);
    expect(github?.credentials).toEqual([{ ref: GITHUB_TOKEN_REF, configured: true }]);
    expect(github?.optional_credentials).toEqual([{ ref: "JARVIS_GITHUB_APP_PRIVATE_KEY", configured: false }]);
    expect(github?.auth?.method).toBe("app");
    for (const c of statuses.filter((x) => x.id !== "github")) {
      expect(c.auth, c.id).toBeUndefined();
      expect(c.optional_credentials, c.id).toBeUndefined();
    }
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "github")?.credential_refs).toEqual([GITHUB_TOKEN_REF]);
    const plain = await listConnectorStatus(gateway);
    expect(plain.find((c) => c.id === "github")?.auth).toBeUndefined();
  });

  it("G3: credentialFacts() for EV-17: kortlevd token med utløp, tildelte scopes (write impliserer read) og D-41 full-kapabilitet som påkrevd", async () => {
    const s = await setup();
    await s.auth.secretProvider(s.secrets).get(GITHUB_TOKEN_REF);
    const facts = s.auth.credentialFacts();
    expect(facts).toMatchObject({ ref: GITHUB_TOKEN_REF, kind: "short_lived_token", expires_at: new Date(T0 + 3_600_000).toISOString(), last_refresh_ok: true, revoked: false, short_lived: true, repo_scoped: true, auth_method: "app" });
    expect(facts.scopes_granted).toEqual(expect.arrayContaining(["contents:write", "contents:read", "pull_requests:write", "issues:write", "actions:write", "metadata:read"]));
    expect(facts.scopes_required).toEqual(expect.arrayContaining(["contents:write", "pull_requests:write", "issues:write", "actions:write", "metadata:read"]));
    expect(GITHUB_FULL_CAPABILITY_PERMISSIONS["actions"]).toBe("write");
  });

  it("G4: knownTokens() gir nylig utstedte tokens til redaksjon av feilmeldinger (withSecretRedaction), og er tom i PAT-modus", async () => {
    const s = await setup({ env: { JARVIS_GIT_ALLOWED_REPOS: "tsworkflow/jarvisbuild,tsworkflow/other-repo" } });
    const token = (await s.auth.secretProvider(s.secrets).get(GITHUB_TOKEN_REF)) ?? "";
    expect(s.auth.knownTokens()).toEqual([token]);
    await s.auth.gitCredentialSource().tokenFor(REPO);
    expect(s.auth.knownTokens()).toHaveLength(2);
  });

  it("G5: ikke-standard API-base logges som advarsel (transport og git bruker fortsatt api.github.com - GHES ikke støttet); standard gir ingen slik advarsel", async () => {
    const withLocal = await setup();
    expect(withLocal.logs.some((l) => l.msg === "github_api_base_non_default")).toBe(true);
    const logs: GitHubAuthLogEvent[] = [];
    createGitHubAuth({ secrets: new MapSecrets({}), env: { JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO }, log: (e) => { logs.push(e); } });
    expect(logs.map((l) => l.msg)).toEqual(["github_auth_mode"]);
  });

  it("G6: en logger som kaster påvirker aldri autentiseringen", async () => {
    const clock = { t: T0 };
    const fake = await FakeGitHubApp.start({ publicKey: keys.publicKey, appId: APP_ID, installationId: INSTALLATION_ID, serverNow: () => clock.t });
    servers.push(fake);
    const secrets = new MapSecrets({ JARVIS_GITHUB_APP_PRIVATE_KEY: keys.pkcs1 });
    const auth = createGitHubAuth({
      secrets, allowLoopbackHttpForTests: true, now: () => clock.t, log: () => { throw new Error("logger nede"); },
      env: { JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO, JARVIS_GITHUB_API_BASE: fake.baseUrl }
    });
    expect(await auth.secretProvider(secrets).get(GITHUB_TOKEN_REF)).toMatch(/^ghs_/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("H: konkurranse og stabilitet", () => {
  it("H1: mange samtidige get() (connector + status + helse-sveip) deler ÉN utstedelse; hasSecret-trafikk hamrer ikke GitHub etter en feil", async () => {
    const s = await setup();
    const provider = s.auth.secretProvider(s.secrets);
    s.fake.mintDelayMs = 40;
    const tokens = await Promise.all(Array.from({ length: 12 }, () => provider.get(GITHUB_TOKEN_REF)));
    expect(new Set(tokens).size).toBe(1);
    expect(s.fake.mintRequests()).toHaveLength(1);

    const failing = await setup();
    failing.fake.script = Array.from({ length: 3 }, (): ScriptedResponse => ({ status: 500 }));
    const failingProvider = failing.auth.secretProvider(failing.secrets);
    expect(await failingProvider.get(GITHUB_TOKEN_REF)).toBeNull();
    const after = failing.fake.requests.length;
    for (let i = 0; i < 20; i += 1) expect(await failingProvider.get(GITHUB_TOKEN_REF)).toBeNull();
    expect(failing.fake.requests.length).toBe(after); // fail-fast: ingen nye kall i vinduet
  });
});
