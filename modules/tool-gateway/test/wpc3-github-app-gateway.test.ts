import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  GithubTransport, InMemoryGithubRateLimitStore, ToolGateway, createGitHubAuth, firstWaveTools, listConnectorStatus, type GitHubAuth, type GitHubAuthLogEvent,
  type SecretProvider
} from "@jarvis/tool-gateway";
import { FakeGitHubApp, testKeys } from "./support/fake-github-app.ts";

/**
 * WP-C3: GitHub App-autentisering gjennom den EKTE `ToolGateway.execute()`-kjeden (embedded Postgres, policy, audit, kill switch/tilbakekalling)
 * og den EKTE `GithubTransport` - uendret. Kun `https://api.github.com` er stubbet (global fetch); token-utstedelsen går mot en lokal fake
 * GitHub (127.0.0.1) som verifiserer App-JWT-en. INGEN eksterne nettkall.
 */

const APP_ID = "123456";
const INSTALLATION_ID = "9876543";
const REPO = "tsworkflow/jarvisbuild";
const PAT = "pat-must-never-appear-in-app-mode-0123456789";
const keys = testKeys();

const owner: IdentityContext = {
  person_id: "p-tobias", tenant_id: "t-a", memory_space_id: "home", session_id: "s", device_id: "d", channel: "voice", auth_strength: "active"
};

class MapSecrets implements SecretProvider {
  readonly name = "map";
  constructor(readonly values: Record<string, string>) {}
  async get(ref: string): Promise<string | null> { return this.values[ref] ?? null; }
}

interface GithubCall { readonly url: string; readonly method: string; readonly authorization: string | null }

describe("WP-C3: GitHub App gjennom ToolGateway + GithubTransport", () => {
  let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let controls: OwnerControls;
  let killSwitch: KillSwitch;
  let policy: PolicyGateway;
  const servers: FakeGitHubApp[] = [];
  const githubCalls: GithubCall[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pgwpc3-"));
    const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
    epg = leased.postgres;
    stopEmbeddedPostgres = leased.stop;
    await epg.createDatabase("jarvis_test");
    adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
    adminPool.on("error", () => undefined);
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_test_wpc3 LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test_wpc3;");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-a','T','person');
      INSERT INTO people (person_id, display_name) VALUES ('p-tobias','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-tobias','t-a');
    `);
    appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_wpc3", password: "pw2" });
    killSwitch = new KillSwitch();
    controls = new OwnerControls(killSwitch);
    policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls,
      authority: { owner_person_id: "p-tobias", owner_tenants: ["t-a"] }
    });
    // Kun api.github.com stubbes; lokal fake (127.0.0.1) går til den ekte fetch.
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith("https://api.github.com/")) return realFetch(input as string, init);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      githubCalls.push({ url, method: init?.method ?? "GET", authorization: headers["authorization"] ?? null });
      if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
        return new Response(JSON.stringify({ full_name: REPO, description: null, updated_at: "2026-10-09T00:00:00Z", default_branch: "main" }), { status: 200 });
      }
      if (url.endsWith("/issues") && init?.method === "POST") {
        return new Response(JSON.stringify({ number: 7, html_url: `https://github.com/${REPO}/issues/7` }), { status: 201 });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    });
  }, 240_000);

  afterEach(async () => {
    githubCalls.length = 0;
    controls.restoreCredential("JARVIS_GITHUB_TOKEN");
    while (servers.length > 0) await servers.pop()?.stop();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await appPool?.end();
    await adminPool?.end();
    await stopEmbeddedPostgres?.();
  }, 120_000);

  async function build(env: Record<string, string> = {}, withKey = true): Promise<{ fake: FakeGitHubApp; auth: GitHubAuth; gateway: ToolGateway; logs: GitHubAuthLogEvent[] }> {
    const fake = await FakeGitHubApp.start({ publicKey: keys.publicKey, appId: APP_ID, installationId: INSTALLATION_ID });
    servers.push(fake);
    const logs: GitHubAuthLogEvent[] = [];
    const base = new MapSecrets({ JARVIS_GITHUB_TOKEN: PAT, ...(withKey ? { JARVIS_GITHUB_APP_PRIVATE_KEY: keys.pkcs1 } : {}) });
    const auth = createGitHubAuth({
      secrets: base, allowLoopbackHttpForTests: true, log: (e) => { logs.push(e); }, sleep: async () => undefined,
      env: { JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: REPO, JARVIS_GITHUB_API_BASE: fake.baseUrl, ...env }
    });
    const gateway = new ToolGateway(appPool, policy, auth.secretProvider(base), controls);
    for (const tool of firstWaveTools({ github: new GithubTransport(auth.rateLimitController(new InMemoryGithubRateLimitStore())) })) gateway.register(tool);
    return { fake, auth, gateway, logs };
  }

  it("A: github.read_repo_meta sender installasjonstokenet (repo-scopet) til api.github.com - aldri PAT-en", async () => {
    const { fake, gateway } = await build();
    const result = await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
    expect(result.ok).toBe(true);
    const token = [...fake.issued.keys()][0] ?? "";
    expect(token).toMatch(/^ghs_/);
    expect(githubCalls).toHaveLength(1);
    expect(githubCalls[0]?.authorization).toBe(`Bearer ${token}`);
    expect(fake.issued.get(token)?.repos).toEqual(["jarvisbuild"]);
    expect(githubCalls.some((c) => c.authorization?.includes(PAT))).toBe(false);
  });

  it("B: neste handling (skriv, klasse B) gjenbruker det cachede tokenet - ÉN utstedelse; audit og feilkanaler inneholder aldri tokenverdien", async () => {
    const { fake, gateway } = await build();
    const read = await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
    const write = await gateway.execute({ identity: owner, tool_id: "github", action: "create_issue", parameters: { repo: REPO, title: "WP-C3 test" }, idempotency_key: "wpc3-issue-1" });
    expect(read.ok).toBe(true);
    expect(write.ok).toBe(true);
    expect(fake.mintRequests()).toHaveLength(1);
    const token = [...fake.issued.keys()][0] ?? "";
    expect(githubCalls.map((c) => c.authorization)).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
    const audit = await adminPool.query("SELECT type, reason, payload::text AS payload FROM audit_events WHERE tool_id = 'github' ORDER BY audit_id");
    expect(audit.rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(audit.rows);
    expect(dump).toContain("JARVIS_GITHUB_TOKEN"); // referansen, aldri verdien
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(PAT);
    expect(JSON.stringify(read) + JSON.stringify(write)).not.toContain(token);
  });

  it("C: tilbakekalt credential (revoke_credential på JARVIS_GITHUB_TOKEN) stopper FØR utstedelse - kill switch/tilbakekalling virker uendret i App-modus", async () => {
    const { fake, gateway } = await build();
    controls.revokeCredential("JARVIS_GITHUB_TOKEN");
    const result = await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
    expect(result).toMatchObject({ ok: false, reason: "credential_revoked" });
    expect(fake.requests).toHaveLength(0);
    expect(githubCalls).toHaveLength(0);
    controls.restoreCredential("JARVIS_GITHUB_TOKEN");
    expect((await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } })).ok).toBe(true);
    killSwitch.activate("test");
    const paused = await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
    killSwitch.deactivate();
    expect(paused.ok).toBe(false);
  });

  it("D: App-feil uten fallback -> credential_unavailable (høylytt i logg og status), ingen kall mot GitHub med PAT; retter eieren feilen virker neste kall", async () => {
    const { fake, auth, gateway, logs } = await build({}, false); // nøkkelen mangler i vaulten
    const result = await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
    expect(result).toMatchObject({ ok: false, reason: "credential_unavailable" });
    expect(githubCalls).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
    expect(logs.find((l) => l.msg === "github_app_auth_failed")).toMatchObject({ level: "error", code: "GITHUB_APP_KEY_MISSING" });
    expect(auth.status()).toMatchObject({ method: "app", state: "app_error" });
    const status = await listConnectorStatus(gateway, { authInfo: (id) => (id === "github" ? auth.connectorAuthInfo() : undefined) });
    const github = status.find((c) => c.id === "github");
    expect(github?.configured).toBe(false); // JARVIS_GITHUB_TOKEN kan ikke leveres akkurat nå
    expect(github?.auth).toMatchObject({ method: "app", short_lived: false, scoped: false });
    expect(github?.auth?.detail["last_error"]).toMatchObject({ code: "GITHUB_APP_KEY_MISSING" });
  });

  it("E: eksplisitt PAT-fallback: feilet utstedelse -> PAT sendes (loggført), connector-status viser pat_fallback_active", async () => {
    const { fake, auth, gateway, logs } = await build({ JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" });
    fake.script = [{ status: 403, json: { message: "Resource not accessible by integration" } }];
    const result = await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
    expect(result.ok).toBe(true);
    expect(githubCalls[0]?.authorization).toBe(`Bearer ${PAT}`);
    expect(logs.some((l) => l.msg === "github_app_pat_fallback_used")).toBe(true);
    expect(auth.connectorAuthInfo().detail).toMatchObject({ pat_fallback_active: true, state: "app_error" });
  });

  it("G (review F3): statuspolling utsteder ALDRI et token - heller ikke mens credentialen er tilbakekalt eller kill switch er aktiv; tilbakekallingen stopper også selve handlingen FØR utstedelse", async () => {
    const { fake, auth, gateway } = await build();
    controls.revokeCredential("JARVIS_GITHUB_TOKEN");
    killSwitch.activate("test");
    try {
      for (let i = 0; i < 15; i += 1) {
        const github = (await listConnectorStatus(gateway, { authInfo: (id) => (id === "github" ? auth.connectorAuthInfo() : undefined) })).find((c) => c.id === "github");
        expect(github?.configured).toBe(true); // nøkkelen finnes - «konfigurert» er presence, ikke helse
      }
      expect(fake.requests).toHaveLength(0); // før rettelsen: ett POST access_tokens per poll (og opptil ~20 s blokkering ved hengende GitHub)
      const denied = await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
      expect(denied.ok).toBe(false);
      expect(fake.requests).toHaveLength(0);
    } finally {
      killSwitch.deactivate();
    }
    controls.restoreCredential("JARVIS_GITHUB_TOKEN");
    expect((await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } })).ok).toBe(true);
    expect(fake.mintRequests()).toHaveLength(1);
  });

  it("F: connector-status for et velfungerende App-oppsett: configured, repo-scopet, kortlevd, med utløp og rettigheter - uten tokenverdi", async () => {
    const { auth, gateway } = await build();
    await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
    const statuses = await listConnectorStatus(gateway, { authInfo: (id) => (id === "github" ? auth.connectorAuthInfo() : undefined) });
    const github = statuses.find((c) => c.id === "github");
    expect(github?.configured).toBe(true);
    expect(github?.optional_credentials).toEqual([{ ref: "JARVIS_GITHUB_APP_PRIVATE_KEY", configured: true }]); // kun tilstedeværelse (boolean) - aldri PEM-verdien
    expect(github?.auth).toMatchObject({ method: "app", short_lived: true, scoped: true });
    expect(github?.auth?.detail).toMatchObject({ installation_id: INSTALLATION_ID, repositories: [REPO], state: "app_ok" });
    expect(github?.health?.state).toBe("healthy");
    const dump = JSON.stringify(statuses);
    expect(dump).not.toMatch(/ghs_[A-Za-z0-9]{10,}/);
    expect(dump).not.toContain(PAT);
  });
});
