import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_GITHUB_REPO } from "@jarvis/contracts";
import type { SecretProvider } from "../src/gateway.ts";
import { GITHUB_APP_ERROR_HINTS, GITHUB_APP_PRIVATE_KEY_REF } from "../src/github-app-auth.ts";
import { GITHUB_FULL_CAPABILITY_PERMISSIONS } from "../src/github-token-provider.ts";
import { runGitHubAppLive, type LiveOptions, type LiveResult } from "../scripts/github-app-live.ts";
import { FakeGitHubApp, testKeys } from "./support/fake-github-app.ts";

/**
 * WP-C3: akseptansescriptet `scripts/github-app-live.ts` - kjørt mot lokal fake GitHub (127.0.0.1) og en stubbet api.github.com. Beviser at scriptet
 * SIER `NOT VERIFIED` med mindre alt påkrevd er PASS, at det aldri skriver token/JWT/nøkkel, at test-grenen alltid ryddes, og at det kun lager
 * en gren når eieren eksplisitt peker på et sandbox-repo. (Det beviser INGENTING om den ekte App-en - eieren må kjøre scriptet selv.)
 */

const APP_ID = "123456";
const INSTALLATION_ID = "9876543";
const keys = testKeys();
const servers: FakeGitHubApp[] = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  vi.unstubAllGlobals();
  while (servers.length > 0) await servers.pop()?.stop();
});

class MapVault implements SecretProvider {
  readonly name = "vault";
  constructor(readonly values: Record<string, string>) {}
  async get(ref: string): Promise<string | null> { return this.values[ref] ?? null; }
}

async function run(options: {
  argv?: string[]; env?: Record<string, string>; vault?: Record<string, string>; fake?: FakeGitHubApp; readFile?: (p: string) => string;
  runGit?: LiveOptions["runGit"];
}): Promise<{ result: LiveResult; output: string }> {
  const out: string[] = [];
  const env = {
    JARVIS_GITHUB_APP_ID: APP_ID, JARVIS_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, JARVIS_GITHUB_REPO: "tsworkflow/jarvisbuild",
    ...(options.fake ? { JARVIS_GITHUB_API_BASE: options.fake.baseUrl } : {}), ...options.env
  };
  const result = await runGitHubAppLive({
    argv: options.argv ?? [], env, log: (line) => out.push(line), vault: new MapVault(options.vault ?? { [GITHUB_APP_PRIVATE_KEY_REF]: keys.pkcs1 }),
    allowLoopbackHttpForTests: true, ...(options.readFile ? { readFile: options.readFile } : {}), ...(options.runGit ? { runGit: options.runGit } : {})
  });
  return { result, output: out.join("\n") };
}

async function fakeGitHub(options: Partial<Omit<Parameters<typeof FakeGitHubApp.start>[0], "publicKey" | "appId" | "installationId">> = {}): Promise<FakeGitHubApp> {
  const fake = await FakeGitHubApp.start({ publicKey: keys.publicKey, appId: APP_ID, installationId: INSTALLATION_ID, ...options });
  servers.push(fake);
  return fake;
}

function expectNoSecrets(output: string, fake?: FakeGitHubApp): void {
  expect(output).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY/);
  expect(output).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./);
  expect(output).not.toMatch(/gh[pousr]_[A-Za-z0-9_]{16,}/);
  for (const token of fake?.issued.keys() ?? []) expect(output).not.toContain(token);
  for (const request of fake?.requests ?? []) if (request.bearer) expect(output).not.toContain(request.bearer);
}

describe("A: uten verifisering er svaret alltid NOT VERIFIED (og scriptet gjør ingenting)", () => {
  it("A1: ingen konfig (PAT-modus) -> BLOCKED_NO_CREDENTIALS, exit 2, tydelig NOT VERIFIED - og NOT VERIFIED står også i åpningsbanneret", async () => {
    const { result, output } = await run({ env: { JARVIS_GITHUB_APP_ID: "", JARVIS_GITHUB_APP_INSTALLATION_ID: "" } });
    expect(result.exitCode).toBe(2);
    expect(result.verified).toBe(false);
    expect(result.checks["app_config"]).toBe("BLOCKED_NO_CREDENTIALS");
    expect(result.status).toMatch(/^NOT VERIFIED/);
    expect(output.split("\n")[1]).toContain("NOT VERIFIED");
    expect(output).toContain("GITHUB_APP_LIVE_STATUS=NOT VERIFIED (ikke konfigurert)");
    expect(Object.values(result.checks).every((v) => v === "NOT_RUN" || v === "BLOCKED_NO_CREDENTIALS")).toBe(true);
  });

  it("A2: delvis/ugyldig konfig -> FAIL (exit 1); manglende nøkkel -> BLOCKED (exit 2); ugyldig nøkkel -> FAIL (exit 1)", async () => {
    const partial = await run({ env: { JARVIS_GITHUB_APP_INSTALLATION_ID: "" } });
    expect(partial.result).toMatchObject({ exitCode: 1, verified: false });
    expect(partial.result.checks["app_config"]).toBe("FAIL");
    const noKey = await run({ vault: {} });
    expect(noKey.result).toMatchObject({ exitCode: 2, verified: false });
    expect(noKey.result.checks["app_private_key"]).toBe("BLOCKED_NO_CREDENTIALS");
    const badKey = await run({ vault: { [GITHUB_APP_PRIVATE_KEY_REF]: "ikke en nøkkel" } });
    expect(badKey.result).toMatchObject({ exitCode: 1, verified: false });
    expect(badKey.result.checks["app_private_key"]).toBe("FAIL");
    expect(badKey.output).not.toContain("ikke en nøkkel");
  });

  it("A3: --help og ukjente/ufullstendige argumenter; ugyldig --sandbox-repo avvises før noe gjøres", async () => {
    expect((await run({ argv: ["--help"] })).result.exitCode).toBe(0);
    for (const argv of [["--ukjent"], ["--key-file"], ["--sandbox-repo"], ["--sandbox-repo", "../x/y"], ["--sandbox-repo", "https://github.com/a/b"]]) {
      const { result } = await run({ argv });
      expect(result.exitCode, argv.join(" ")).toBe(1);
      expect(result.verified).toBe(false);
    }
  });
});

describe("B: standardmodus mot fake GitHub - kun lesing og token-utstedelse", () => {
  it("B1: alt PASS -> VERIFIED (kun autentisering); tokenet revokeres, ingenting skrives, ingen hemmeligheter i utskriften; sandbox-sjekkene er NOT_RUN", async () => {
    const fake = await fakeGitHub();
    const { result, output } = await run({ fake });
    expect(result.checks).toMatchObject({
      app_config: "PASS", app_private_key: "PASS", installation_inspect: "PASS", token_issue: "PASS", token_scope_exact: "PASS", permissions_full_capability: "PASS",
      rate_limit: "PASS", token_revoked: "PASS", secret_safety: "PASS", sandbox_read: "NOT_RUN", sandbox_branch_roundtrip: "NOT_RUN", sandbox_git_ls_remote: "NOT_RUN"
    });
    expect(result).toMatchObject({ exitCode: 0, verified: true });
    expect(result.status).toContain("kun autentisering");
    expect(result.status).toContain("--sandbox-repo");
    expect(output).toContain(`GITHUB_APP_LIVE_STATUS=${result.status}`);
    expect(fake.mintRequests()).toHaveLength(1);
    expect(JSON.parse(fake.mintRequests()[0]?.body ?? "{}")).toEqual({ repositories: ["jarvisbuild"] });
    expect([...fake.issued.values()].every((t) => t.revoked)).toBe(true);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /app/installations/${INSTALLATION_ID}`, `POST /app/installations/${INSTALLATION_ID}/access_tokens`, "GET /rate_limit", "DELETE /installation/token", "GET /rate_limit"
    ]);
    expectNoSecrets(output, fake);
  });

  it("B2: nøkkelen kan komme fra --key-file (selv om vaulten er tom); filen leses lokalt og innholdet skrives aldri ut", async () => {
    const fake = await fakeGitHub();
    const { result, output } = await run({ fake, vault: {}, argv: ["--key-file", "./nokkel.pem"], readFile: (p) => { expect(p).toBe("./nokkel.pem"); return keys.pkcs1; } });
    expect(result.verified).toBe(true);
    expectNoSecrets(output, fake);
    const unreadable = await run({ fake, argv: ["--key-file", "./finnes-ikke.pem"], readFile: () => { throw new Error("ENOENT hemmelig/sti"); } });
    expect(unreadable.result).toMatchObject({ exitCode: 1, verified: false });
    expect(unreadable.output).not.toContain("hemmelig/sti");
  });

  it("B3: installasjon med «alle repoer» og manglende Actions-rettighet gir WARN (ikke FAIL): VERIFIED med advarsler som står i statuslinjen", async () => {
    const fake = await fakeGitHub({ repositorySelection: "all", installationPermissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write" } });
    const { result, output } = await run({ fake });
    expect(result.checks["installation_inspect"]).toBe("WARN");
    expect(result.checks["permissions_full_capability"]).toBe("WARN");
    expect(result.diagnostics["permissions_full_capability"]).toContain("actions:write");
    expect(result.diagnostics["installation_inspect"]).toContain("ALLE repoer");
    expect(result).toMatchObject({ exitCode: 0, verified: true });
    expect(result.status).toContain("advarsler: installation_inspect, permissions_full_capability");
    expectNoSecrets(output, fake);
  });

  it("B4: suspendert installasjon / ukjent installasjon / avvist JWT -> FAIL med norsk tiltak, exit 1, NOT VERIFIED", async () => {
    let fake = await fakeGitHub();
    fake.installationOverride = { status: 200, json: { id: 1, repository_selection: "selected", permissions: {}, suspended_at: "2026-10-01T00:00:00Z", account: { login: "x", type: "User" } } };
    let r = await run({ fake });
    expect(r.result.checks["installation_inspect"]).toBe("FAIL");
    expect(r.result).toMatchObject({ exitCode: 1, verified: false });

    fake = await fakeGitHub();
    r = await run({ fake, env: { JARVIS_GITHUB_APP_INSTALLATION_ID: "111" } });
    expect(r.result.checks["installation_inspect"]).toBe("FAIL");
    expect(r.result.diagnostics["installation_inspect"]).toContain("GITHUB_APP_INSTALLATION_NOT_FOUND");
    expect(r.result.verified).toBe(false);

    fake = await fakeGitHub();
    r = await run({ fake, env: { JARVIS_GITHUB_APP_ID: "999" } });
    expect(r.result.checks["installation_inspect"]).toBe("FAIL");
    expect(r.result.diagnostics["installation_inspect"]).toContain("GITHUB_APP_AUTH_FAILED");
    expect(r.result.exitCode).toBe(1);
  });

  it("B5: et token som ikke dekker NØYAKTIG forespurt repo gir FAIL (leverandøren utvidet scopet) - aldri VERIFIED", async () => {
    const fake = await fakeGitHub();
    fake.script = [{ status: 201, build: () => ({ status: 201, json: { ...fake.buildTokenBody({ repositories: ["jarvisbuild", "other-repo"] }) } }) }];
    const { result } = await run({ fake });
    expect(result.checks["token_issue"]).toBe("FAIL");
    expect(result.diagnostics["token_issue"]).toContain("GITHUB_APP_SCOPE_MISMATCH");
    expect(result).toMatchObject({ exitCode: 1, verified: false });
  });

  it("B6: --list-installations viser installasjons-id (kun JWT), stopper uten å utstede token, og er fortsatt NOT VERIFIED", async () => {
    const fake = await fakeGitHub();
    const { result, output } = await run({ fake, argv: ["--list-installations"], env: { JARVIS_GITHUB_APP_INSTALLATION_ID: "" } });
    expect(output).toContain(`JARVIS_GITHUB_APP_INSTALLATION_ID=${INSTALLATION_ID}`);
    expect(output).toContain("konto=tsworkflow");
    expect(result.verified).toBe(false);
    expect(result.status).toMatch(/^NOT VERIFIED/);
    expect(fake.mintRequests()).toHaveLength(0);
    expectNoSecrets(output, fake);
  });
});

describe("C: --sandbox-repo - lese-sjekker, test-gren som ALLTID ryddes, git ls-remote med token kun i miljøet", () => {
  interface GithubCall { method: string; url: string }

  function stubApiGithub(calls: GithubCall[], behaviour: { secondCreateFails?: boolean; deleteFails?: boolean } = {}): void {
    let creates = 0;
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith("https://api.github.com/")) return realFetch(input as string, init);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
      if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) return json(200, { full_name: "tsworkflow/other-repo", description: null, updated_at: "x", default_branch: "main" });
      if (method === "GET" && url.includes("/branches/main")) return json(200, { name: "main", commit: { sha: "a".repeat(40) }, protected: true });
      if (method === "GET" && url.includes("/pulls")) return json(200, []);
      if (method === "GET" && url.includes("/actions/runs")) return json(200, { workflow_runs: [] });
      if (method === "POST" && url.endsWith("/git/refs")) {
        creates += 1;
        if (creates === 1) return json(201, { object: { sha: "a".repeat(40) } });
        if (behaviour.secondCreateFails) return json(500, { message: "boom" });
        return json(422, { message: "Reference already exists" });
      }
      if (method === "GET" && url.includes("/git/refs/heads/jarvis-app-live-")) return json(200, { object: { sha: "a".repeat(40) } });
      if (method === "DELETE" && url.includes("/git/refs/heads/jarvis-app-live-")) return behaviour.deleteFails ? json(500, { message: "boom" }) : new Response(null, { status: 204 });
      return json(404, { message: "Not Found" });
    });
  }

  it("C1: les -> opprett test-gren (idempotent) -> slett test-gren -> git ls-remote; tokenet er aldri i argv, kun i git-miljøet; VERIFIED uten advarsel om sandbox", async () => {
    const fake = await fakeGitHub();
    const calls: GithubCall[] = [];
    stubApiGithub(calls);
    const gitCalls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const { result, output } = await run({
      fake, argv: ["--sandbox-repo", "tsworkflow/other-repo"],
      runGit: (args, env) => { gitCalls.push({ args, env }); return { status: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n` }; }
    });
    expect(result.checks).toMatchObject({ sandbox_read: "PASS", sandbox_branch_roundtrip: "PASS", sandbox_git_ls_remote: "PASS", token_issue: "PASS", token_revoked: "PASS", secret_safety: "PASS" });
    expect(result).toMatchObject({ exitCode: 0, verified: true });
    expect(result.status).toBe("VERIFIED");
    expect(JSON.parse(fake.mintRequests()[0]?.body ?? "{}")).toEqual({ repositories: ["other-repo"] });
    const methods = calls.map((c) => c.method);
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(1); // test-grenen ryddet
    expect(calls.some((c) => c.url.includes("/git/refs/heads/main") && c.method === "DELETE")).toBe(false); // aldri beskyttet gren
    const token = [...fake.issued.keys()][0] ?? "";
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0]?.args).toEqual(["ls-remote", "--heads", "https://github.com/tsworkflow/other-repo.git"]);
    expect(gitCalls[0]?.args.join(" ")).not.toContain(token);
    expect(Buffer.from((gitCalls[0]?.env["GIT_CONFIG_VALUE_0"] ?? "").replace("Authorization: Basic ", ""), "base64").toString()).toBe(`x-access-token:${token}`);
    expectNoSecrets(output, fake);
  });

  it("C2: feiler gren-opprettelsen nr. 2 -> sandbox_branch_roundtrip FAIL, men test-grenen slettes LIKEVEL (opprydding uavhengig av utfall) og resultatet er NOT VERIFIED", async () => {
    const fake = await fakeGitHub();
    const calls: GithubCall[] = [];
    stubApiGithub(calls, { secondCreateFails: true });
    const { result } = await run({ fake, argv: ["--sandbox-repo", "tsworkflow/other-repo"], runGit: () => ({ status: 0, stdout: "" }) });
    expect(result.checks["sandbox_branch_roundtrip"]).toBe("FAIL");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 1, verified: false });
  });

  it("C3: kan test-grenen ikke slettes, står det tydelig i utskriften (slett manuelt) og resultatet er FAIL", async () => {
    const fake = await fakeGitHub();
    stubApiGithub([], { deleteFails: true });
    const { result, output } = await run({ fake, argv: ["--sandbox-repo", "tsworkflow/other-repo"], runGit: () => ({ status: 0, stdout: "" }) });
    expect(result.checks["sandbox_branch_roundtrip"]).toBe("FAIL");
    expect(output).toContain("slett den manuelt");
    expect(result.verified).toBe(false);
  });

  it("C4: UTEN --sandbox-repo gjøres ingen skriving og ingen kall mot api.github.com i det hele tatt", async () => {
    const fake = await fakeGitHub();
    const calls: GithubCall[] = [];
    stubApiGithub(calls);
    await run({ fake });
    expect(calls).toEqual([]);
    expect(fake.requests.every((r) => ["GET", "POST", "DELETE"].includes(r.method))).toBe(true);
    expect(fake.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/app/installations/${INSTALLATION_ID}/access_tokens`]);
  });
});

describe("C5: --sandbox-repo NEKTER produksjonsrepoet (review F14) - scriptet skriver aldri en test-gren i et produksjonsrepo", () => {
  it("C5a: allowlisten (JARVIS_GITHUB_REPO), JARVIS_GIT_ALLOWED_REPOS og standardrepoet nektes i alle skrivemåter - ingen kall mot GitHub i det hele tatt (heller ikke token-utstedelse)", async () => {
    const cases: Array<[string, string, Record<string, string>]> = [
      ["JARVIS_GITHUB_REPO", "tsworkflow/jarvisbuild", {}],
      ["store/små bokstaver", "TSWORKFLOW/JarvisBuild", {}],
      ["JARVIS_GIT_ALLOWED_REPOS", "tsworkflow/andre", { JARVIS_GIT_ALLOWED_REPOS: "tsworkflow/jarvisbuild,tsworkflow/andre" }],
      ["repoet connectoren er konfigurert mot, utenfor allowlisten", "tsworkflow/connector-repo", { JARVIS_GITHUB_REPO: "tsworkflow/connector-repo", JARVIS_GIT_ALLOWED_REPOS: "tsworkflow/jarvisbuild" }],
      ["standardrepoet (CANONICAL_GITHUB_REPO) når JARVIS_GITHUB_REPO peker et annet sted", CANONICAL_GITHUB_REPO, { JARVIS_GITHUB_REPO: "tsworkflow/annet" }],
      ["det gamle, frosne produksjonsrepoet (LEGACY_GITHUB_REPOS, D-479) når JARVIS_GITHUB_REPO peker et annet sted", "tsworkflow/jarvisbuild", { JARVIS_GITHUB_REPO: "tsworkflow/annet" }],
      ["det gamle repoet i andre skrivemåter (D-479)", "TSWorkflow/JarvisBuild", { JARVIS_GITHUB_REPO: "tsworkflow/annet" }],
      // GitHub behandler `eier/repo` og `eier/repo.git` som samme repo: et `.git`-alias skal ikke omgå vernet (D-479, githubRepoAliasKey).
      ["det kanoniske repoet med .git-suffiks", `${CANONICAL_GITHUB_REPO}.git`, { JARVIS_GITHUB_REPO: "tsworkflow/annet" }],
      ["det gamle repoet med store bokstaver og .GIT", "TSWorkflow/JarvisBuild.GIT", { JARVIS_GITHUB_REPO: "tsworkflow/annet" }],
      ["det gamle repoet med gjentatt .git.git", "tsworkflow/jarvisbuild.git.git", { JARVIS_GITHUB_REPO: "tsworkflow/annet" }],
      // Forken het `FFrollerskis/jarvisbuild` før omdøpingen til `jarvis-build` (D-478 pkt 2); GitHub videresender det gamle navnet, så det ER produksjonsrepoet.
      ["forkets tidligere navn (GitHub videresender det)", "FFrollerskis/jarvisbuild", { JARVIS_GITHUB_REPO: "tsworkflow/annet" }],
      ["forkets tidligere navn med .git og store bokstaver", "FFROLLERSKIS/JarvisBuild.GIT", { JARVIS_GITHUB_REPO: "tsworkflow/annet" }],
      ["JARVIS_GITHUB_REPO med .git-suffiks mot sandbox uten", "tsworkflow/prod-repo", { JARVIS_GITHUB_REPO: "tsworkflow/prod-repo.git" }],
      ["JARVIS_GITHUB_REPO uten suffiks mot sandbox med .git", "tsworkflow/prod-repo.git", { JARVIS_GITHUB_REPO: "tsworkflow/prod-repo" }],
      ["JARVIS_GIT_ALLOWED_REPOS med store bokstaver og .git mot sandbox uten", "tsworkflow/andre", { JARVIS_GIT_ALLOWED_REPOS: "TSWorkflow/Andre.git" }]
    ];
    for (const [name, sandbox, env] of cases) {
      const fake = await fakeGitHub();
      const gitCalls: unknown[] = [];
      const { result, output } = await run({ fake, env, argv: ["--sandbox-repo", sandbox], runGit: (args) => { gitCalls.push(args); return { status: 0, stdout: "" }; } });
      expect(result, name).toMatchObject({ exitCode: 1, verified: false });
      expect(result.status, name).toContain("NOT VERIFIED (--sandbox-repo er et produksjonsrepo)");
      expect(result.checks["app_config"], name).toBe("FAIL");
      expect(result.diagnostics["app_config"], name).toContain("produksjonsrepo");
      expect(output, name).toContain("GITHUB_APP_LIVE_STATUS=NOT VERIFIED");
      expect(fake.requests, name).toHaveLength(0); // verken installasjonslesing eller token-utstedelse
      expect(gitCalls, name).toHaveLength(0);
      expect(Object.values(result.checks).filter((v) => v === "PASS"), name).toHaveLength(0);
    }
  });

  it("C5b: et ekte test-repo (ikke i produksjonslisten) går fortsatt gjennom, og sandbox-tokenet utstedes av en klient som KUN kan utstede for test-repoet", async () => {
    const fake = await fakeGitHub();
    const realFetchStub = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith("https://api.github.com/")) return realFetch(input as string, init);
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", realFetchStub);
    const { result } = await run({ fake, argv: ["--sandbox-repo", "tsworkflow/other-repo"], runGit: () => ({ status: 0, stdout: "" }) });
    expect(result.checks["token_issue"]).toBe("PASS");
    expect(result.checks["token_scope_exact"]).toBe("PASS");
    const bodies = fake.mintRequests().map((r) => JSON.parse(r.body) as { repositories: string[] });
    expect(bodies).toEqual([{ repositories: ["other-repo"] }]);
    expect(result.diagnostics["app_config"]).toBeUndefined();
  });
});

describe("D: runbooken (docs/runbooks/GITHUB_APP.md) er i takt med koden", () => {
  const runbook = readFileSync(fileURLToPath(new URL("../../../docs/runbooks/GITHUB_APP.md", import.meta.url)), "utf8");

  it("D1: hver feilkategori som kan nå eieren, hver miljøvariabel og vault-refen står i runbooken", () => {
    for (const code of Object.keys(GITHUB_APP_ERROR_HINTS)) {
      if (code === "GITHUB_APP_NOT_CONFIGURED" || code === "GITHUB_TOKEN_UNAVAILABLE") continue; // interne: PAT-modus / git-kilde uten PAT
      expect(runbook, code).toContain(code);
    }
    for (const name of ["JARVIS_GITHUB_APP_ID", "JARVIS_GITHUB_APP_INSTALLATION_ID", "JARVIS_GITHUB_REPO", "JARVIS_GIT_ALLOWED_REPOS", "JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK", "JARVIS_GITHUB_API_BASE", GITHUB_APP_PRIVATE_KEY_REF]) {
      expect(runbook, name).toContain(name);
    }
  });

  it("D2: runbooken sier ærlig at ingenting er verifisert mot ekte GitHub, og at akseptansescriptet er NOT VERIFIED til det er kjørt", () => {
    expect(runbook).toMatch(/IKKE VERIFISERT MOT EKTE GITHUB/);
    expect(runbook).toContain("NOT VERIFIED");
    expect(runbook).toContain("GITHUB_APP_LIVE_STATUS=VERIFIED");
  });

  it("D4 (review F2/F3): runbooken sier det koden gjør - tilbakekalling stopper også kodejobbens git-credential, git-tokenet er repo-scopet med minste rettighet, og begrensningene står ærlig", () => {
    expect(runbook).toMatch(/OG kodejobbenes git-credential FØR noe token utstedes/);
    expect(runbook).toMatch(/minste rettighet \(kun Contents: write/);
    expect(runbook).toMatch(/RETT FØR hver\s+git-nettverksoperasjon/);
    expect(runbook).toContain("## Kjente begrensninger (ærlig)");
    expect(runbook).toMatch(/Connector-tokenet er ikke nedskalert \(bevisst, D-41\)/);
    expect(runbook).toContain("SelfModificationService");
  });

  it("D5 (review F7): ingen dokumentasjon påstår «hver bruk logges» om PAT-fallback - loggen er ratebegrenset (maks én linje per minutt), og det står i runbook, .env.example og kildekommentaren", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const sources: Record<string, string> = {
      runbook, ".env.example": readFileSync(`${root}.env.example`, "utf8"),
      "github-token-provider.ts": readFileSync(`${root}modules/tool-gateway/src/github-token-provider.ts`, "utf8")
    };
    for (const [name, text] of Object.entries(sources)) {
      expect(text, name).not.toMatch(/hver bruk logges/i);
      expect(text, name).not.toMatch(/hver bruk er loggført/i);
      expect(text, name).toMatch(/ratebegrenset/i);
      expect(text, name).toMatch(/maks én linje per minutt/);
    }
  });

  it("D6 (review F2): runbooken sier at kodejobbens git-token aldri ber om Workflows (kun Contents), og at feilkodene for tilbakekalling finnes", () => {
    expect(runbook).toMatch(/Kodejobbens git-token ber aldri om Workflows/);
    expect(runbook).toContain("git_auth_revoked");
    expect(runbook).toContain("git_auth_revocation_check_failed");
    expect(runbook).toContain("git_auth_unavailable:<kode>");
    // Ærlig om hullet: akseptansescriptet utsteder ikke kodejobbens snevre git-token (PARTIAL).
    expect(runbook).toMatch(/Akseptansescriptet dekker ikke kodejobbens snevre git-token ennå \(`PARTIAL`\)/);
  });

  it("D3: rettighetene koden krever for full kapabilitet (D-41) står alle i rettighetstabellen med riktig nivå", () => {
    const names: Record<string, string> = { metadata: "Metadata", contents: "Contents", pull_requests: "Pull requests", issues: "Issues", actions: "Actions" };
    for (const [permission, level] of Object.entries(GITHUB_FULL_CAPABILITY_PERMISSIONS)) {
      const row = runbook.split("\n").find((line) => line.startsWith(`| **${names[permission]}**`));
      expect(row, permission).toBeDefined();
      expect(row, permission).toContain(level === "write" ? "Read and write" : "Read-only");
    }
  });
});
