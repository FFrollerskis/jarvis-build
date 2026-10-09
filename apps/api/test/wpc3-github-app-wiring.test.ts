import { spawnSync } from "node:child_process";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { JobContract } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  GIT_CREDENTIAL_TOKEN_ENV, ProcessSandboxRunner, createCodingHandler, withSecretRedaction,
  type ArtifactStore, type ClaimedTask, type CodingAgentAdapter, type CodingAgentExec, type ExecResult, type JobContext, type Sandbox, type SandboxRunner
} from "@jarvis/tasks";
import { createGitHubAuth, type SecretProvider } from "@jarvis/tool-gateway";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { CONNECTOR_ENV, SERVICE_ENV, WORKER_CONNECTOR_ENV } from "../../../infra/local/service-env.mjs";

/**
 * WP-C3 (Q-45 b / D-35): wiring av GitHub App-autentisering i api/worker + en EKTE `createCodingHandler`-kjøring mot et lokalt bare-repo der
 * git-credentialen kommer fra et kortlevd, repo-scopet installasjonstoken (utstedelsen er stubbet - ingen nettkall).
 */

const readSource = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const mainSource = readSource("../src/main.ts");
const workerSource = readSource("../src/worker-main.ts");
const envExample = readSource("../../../.env.example");
const compose = readSource("../../../infra/local/docker-compose.yml");
const NEW_ENV = ["JARVIS_GITHUB_API_BASE", "JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK", "JARVIS_GITHUB_APP_ID", "JARVIS_GITHUB_APP_INSTALLATION_ID"];

describe("A: komposisjonsrotene (main.ts / worker-main.ts) kobler GitHub-autentiseringen riktig", () => {
  it("A1: begge bygger createGitHubAuth over den EKSISTERENDE secret-kjeden og eksponerer den dekorerte kjeden under de eksisterende navnene (readSecretProvider / toolSecretProvider)", () => {
    expect(mainSource).toMatch(/const githubAuth = createGitHubAuth\(\{ secrets: baseSecretProvider, env: process\.env \}\);\s*\n\s*const readSecretProvider = githubAuth\.secretProvider\(baseSecretProvider\);/);
    expect(workerSource).toMatch(/const githubAuth = createGitHubAuth\(\{ secrets: baseToolSecretProvider, env: process\.env \}\);\s*\nconst toolSecretProvider = githubAuth\.secretProvider\(baseToolSecretProvider\);/);
    // Kjeden under er uendret: Infisical primær, env, BusinessInternal.
    expect(mainSource).toMatch(/const baseSecretProvider = new FallbackSecretProvider\(\s*infisicalSecretProvider,\s*new FallbackSecretProvider\(new EnvSecretProvider\(\), new BusinessInternalSecretProvider\(\)\)\s*\);/);
    expect(workerSource).toMatch(/const baseToolSecretProvider = new FallbackSecretProvider\(\s*infisicalSecretProvider,\s*new FallbackSecretProvider\(new EnvSecretProvider\(\), new BusinessInternalSecretProvider\(\)\)\s*\);/);
  });

  it("A2: ToolGateway får den dekorerte kjeden som les-kilde og den RÅ Infisical-instansen som skrive-kilde (uendret skrivevei)", () => {
    expect(mainSource).toContain("new ToolGateway(pool, policy, readSecretProvider, ownerControls, infisicalSecretProvider, {");
    expect(workerSource).toContain("new ToolGateway(pool, policy, toolSecretProvider, ownerControls, infisicalSecretProvider, {");
  });

  it("A3: rate-limit-kontrolleren lages via githubAuth (nøkkel per installasjon i App-modus, uendret i PAT-modus) og GithubTransport får den som før", () => {
    expect(mainSource).toMatch(/const githubRateLimitController = githubAuth\.rateLimitController\(\s*(?:\/\/[^\n]*\n\s*)?new PgGithubRateLimitStore\(pool\),/);
    expect(workerSource).toMatch(/const githubRateLimitController = githubAuth\.rateLimitController\(\s*(?:\/\/[^\n]*\n\s*)?new PgGithubRateLimitStore\(pool\),/);
    expect(mainSource).toContain("github: new GithubTransport(githubRateLimitController)");
    expect(workerSource).toContain("github: new GithubTransport(githubRateLimitController)");
  });

  it("A4: get_connector_status får autentiseringsmetadata fra githubAuth (kun for github); ingen credential-verdier", () => {
    expect(mainSource).toContain('connectorAuth: (connectorId) => (connectorId === "github" ? githubAuth.connectorAuthInfo() : undefined)');
  });

  it("A5: kodejobb-workeren: gitAuth går via githubAuth (PAT-kilde = EnvSecretProvider som før) og feilredaksjonen leser installasjonstokens PÅ FEILTIDSPUNKTET", () => {
    const callIdx = workerSource.indexOf('worker.register(\n  "coding"');
    expect(callIdx).toBeGreaterThan(-1);
    const block = workerSource.slice(callIdx, workerSource.indexOf("\n);", callIdx) + 3);
    expect(block).toContain("gitAuth: { secretProvider: githubAuth.secretProvider(new EnvSecretProvider()) }");
    expect(block).toContain('() => [process.env["ANTHROPIC_API_KEY"], process.env["JARVIS_GITHUB_TOKEN"], ...githubAuth.knownTokens()]');
  });

  it("A6: ingen av de to filene leser App-konfig eller nøkkel direkte fra process.env (alt går via createGitHubAuth / SecretProvider)", () => {
    for (const source of [mainSource, workerSource]) {
      expect(source).not.toMatch(/process\.env\[\s*["']JARVIS_GITHUB_APP_/);
      expect(source).not.toContain("JARVIS_GITHUB_APP_PRIVATE_KEY");
    }
  });
});

describe("B: miljø - nye variabler videresendes, privatnøkkelen gjør det ALDRI", () => {
  it("B1: de fire ikke-hemmelige/konfig-variablene står i connector-manifestet for api OG worker, og compose er generert fra det", () => {
    for (const name of NEW_ENV) {
      expect(CONNECTOR_ENV as string[], name).toContain(name);
      expect(WORKER_CONNECTOR_ENV as string[], name).toContain(name);
      expect(SERVICE_ENV.api as string[], name).toContain(name);
      expect(SERVICE_ENV.worker as string[], name).toContain(name);
      expect(compose, name).toContain(`${name}: "\${${name}:-}"`);
    }
  });

  it("B2: JARVIS_GITHUB_APP_PRIVATE_KEY finnes i INGEN tjenestes env-manifest og ikke i compose - kun vaulten (flerlinje-PEM er ikke en trygg env-verdi)", () => {
    for (const [service, names] of Object.entries(SERVICE_ENV as Record<string, string[]>)) {
      expect(names, service).not.toContain("JARVIS_GITHUB_APP_PRIVATE_KEY");
    }
    expect(compose).not.toContain("JARVIS_GITHUB_APP_PRIVATE_KEY");
    expect(CONNECTOR_ENV as string[]).not.toContain("JARVIS_GITHUB_APP_PRIVATE_KEY");
  });

  it("B3: .env.example dokumenterer alle fem navnene, sier at nøkkelen hører hjemme i vaulten, og har trygg standard (alt kommentert ut = PAT)", () => {
    for (const name of [...NEW_ENV, "JARVIS_GITHUB_APP_PRIVATE_KEY"]) expect(envExample, name).toMatch(new RegExp(`^# ${name}=`, "m"));
    expect(envExample).toMatch(/PRIVATNØKKELEN \(PEM\) settes ALDRI her: lagre den i vaulten/);
    for (const name of [...NEW_ENV, "JARVIS_GITHUB_APP_PRIVATE_KEY"]) expect(envExample, name).not.toMatch(new RegExp(`^${name}=`, "m"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// C: EKTE createCodingHandler med App-basert gitAuth
// ---------------------------------------------------------------------------------------------------------------------------------

const GITHUB_SHAPED_URL = "https://github.com/tsworkflow/jarvisbuild-wpc3-test.git";
const ALLOWED_REPO = "tsworkflow/jarvisbuild-wpc3-test";
const PAT = "env-pat-that-only-exists-as-explicit-fallback-0123";
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
let bareRepo = "";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
  return result.stdout.trim();
}

class WritingFakeAgent implements CodingAgentAdapter {
  readonly name = "fake-agent";
  async modify(exec: CodingAgentExec): Promise<string> {
    await exec("node", ["-e", "require('fs').writeFileSync('CHANGES.md','endret')"]);
    return "endret CHANGES.md";
  }
}

interface CapturedCall { command: string; args: string[]; extraEnv: Record<string, string> | undefined }

class CapturingRedirectingSandboxRunner implements SandboxRunner {
  readonly name = "capturing-redirect-sandbox";
  readonly calls: CapturedCall[] = [];
  constructor(private readonly inner: SandboxRunner, private readonly redirectFrom: string, private readonly redirectTo: string) {}
  async create(jobEnv?: Record<string, string>): Promise<Sandbox> {
    const sandbox = await this.inner.create(jobEnv);
    return {
      workdir: sandbox.workdir,
      exec: async (command: string, args: string[], timeoutMs?: number, extraEnv?: Record<string, string>): Promise<ExecResult> => {
        let rewritten = args.map((a) => (a === this.redirectFrom ? this.redirectTo : a));
        if (command === "git") {
          const idx = rewritten.findIndex((a) => a === "clone" || a === "push");
          if (idx >= 0) rewritten = [...rewritten.slice(0, idx), "-c", "protocol.file.allow=always", ...rewritten.slice(idx)];
        }
        this.calls.push({ command, args: rewritten, extraEnv });
        return sandbox.exec(command, rewritten, timeoutMs, extraEnv);
      },
      dispose: () => sandbox.dispose()
    };
  }
}

function jobContract(): JobContract {
  return {
    task_id: `task-wpc3-${randomBytes(4).toString("hex")}`, owner_person_id: "person-tobias", tenant_id: "tenant-a", goal: "wpc3", acceptance_criteria: ["fullfører"],
    input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" }, allowed_tools: ["github"], allowed_memory_spaces: ["personal"],
    allowed_network_targets: [], agent_profile: "coding", model_budget_ore: 1000, retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3
  } as JobContract;
}

const identity = { person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal", session_id: "sess-wpc3", device_id: "dev-pc", channel: "web", auth_strength: "active" } as const;

function claimed(): ClaimedTask {
  const contract = jobContract();
  return { task_id: contract.task_id, tenant_id: "tenant-a", contract, attempts: 1, checkpoint: null };
}
const jobContext: JobContext = { attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled: async () => undefined };

class MapSecrets implements SecretProvider {
  readonly name = "map";
  constructor(readonly values: Record<string, string>) {}
  async get(ref: string): Promise<string | null> { return this.values[ref] ?? null; }
}

/** Stubbet GitHub: utsteder installasjonstokens som ekko av forespurt scope. Returnerer også hva som ble utstedt/forespurt. */
function stubGitHub(options: { failStatus?: number } = {}): { http: (url: string, init: RequestInit) => Promise<Response>; issued: string[]; requested: string[][] } {
  const issued: string[] = [];
  const requested: string[][] = [];
  return {
    issued, requested,
    http: async (_url, init) => {
      const body = JSON.parse(String(init.body ?? "{}")) as { repositories?: string[] };
      requested.push(body.repositories ?? []);
      if (options.failStatus) return new Response(JSON.stringify({ message: "Not Found" }), { status: options.failStatus });
      const token = `ghs_${randomBytes(24).toString("hex")}`;
      issued.push(token);
      return new Response(JSON.stringify({
        token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { contents: "write" }, repository_selection: "selected",
        repositories: (body.repositories ?? []).map((name, i) => ({ id: i + 1, name, full_name: `tsworkflow/${name}` }))
      }), { status: 201 });
    }
  };
}

function makeAuth(github: ReturnType<typeof stubGitHub>, env: Record<string, string> = {}) {
  return createGitHubAuth({
    secrets: new MapSecrets({ JARVIS_GITHUB_APP_PRIVATE_KEY: PEM }), log: () => undefined, http: github.http, sleep: async () => undefined, maxAttempts: 1,
    env: { JARVIS_GITHUB_APP_ID: "123456", JARVIS_GITHUB_APP_INSTALLATION_ID: "42", JARVIS_GITHUB_REPO: ALLOWED_REPO, ...env }
  });
}

function makeHandler(sandbox: SandboxRunner, secretProvider: SecretProvider, artifacts: { texts: string[] }) {
  const store = { save: async (_t: string, _task: string, _kind: string, _name: string, content: string) => { artifacts.texts.push(content); }, list: async () => [] } as unknown as ArtifactStore;
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"]) });
  return createCodingHandler({
    sandbox, agent: new WritingFakeAgent(), artifacts: store, policy, identityFor: () => identity, allowedRepos: [ALLOWED_REPO], gitAuth: { secretProvider }
  });
}

describe("C: createCodingHandler med App-basert gitAuth.secretProvider (ingen endring i coding.ts nødvendig)", () => {
  beforeAll(async () => {
    bareRepo = await mkdtemp(join(tmpdir(), "jarvis-wpc3-origin-"));
    git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
    const seed = await mkdtemp(join(tmpdir(), "jarvis-wpc3-seed-"));
    git(seed, "init", "--initial-branch=main", ".");
    git(seed, "config", "user.email", "seed@test");
    git(seed, "config", "user.name", "seed");
    spawnSync("node", ["-e", "require('fs').writeFileSync('README.md','# repo')"], { cwd: seed });
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "init");
    git(seed, "push", bareRepo, "main");
  }, 120_000);

  it("C1: clone OG push får installasjonstokenet (repo-scopet, utstedt for NØYAKTIG allowlist-repoet) i git-underprosessens env - aldri i argv, artefakter eller agentens kall", async () => {
    const github = stubGitHub();
    const auth = makeAuth(github);
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const artifacts = { texts: [] as string[] };
    const task = claimed();
    const result = await makeHandler(sandbox, auth.secretProvider(new MapSecrets({ JARVIS_GITHUB_TOKEN: PAT })), artifacts)(task, jobContext);
    expect(result["tests"]).toBe("passed");
    expect(github.requested).toEqual([["jarvisbuild-wpc3-test"]]);
    expect(github.issued).toHaveLength(1);
    const token = github.issued[0] as string;
    const clone = sandbox.calls.find((c) => c.args.includes("clone"));
    const push = sandbox.calls.find((c) => c.args.includes("push"));
    expect(clone?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe(token);
    expect(push?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe(token);
    for (const call of sandbox.calls) {
      for (const arg of call.args) expect(arg).not.toContain(token);
      if (call !== clone && call !== push) expect(call.extraEnv).toBeUndefined();
    }
    expect(artifacts.texts.join("\n")).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(git(bareRepo, "branch", "--list", `jarvis/${task.task_id}`)).toContain(`jarvis/${task.task_id}`); // ekte push lyktes
    expect(JSON.stringify(sandbox.calls)).not.toContain(PAT); // PAT-en er ikke i bruk i App-modus
  }, 60_000);

  it("C2: utstedelse feiler uten fallback -> jobben feiler LUKKET før clone (git_auth_unavailable); PAT-en brukes aldri", async () => {
    const github = stubGitHub({ failStatus: 404 });
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const handler = makeHandler(sandbox, makeAuth(github).secretProvider(new MapSecrets({ JARVIS_GITHUB_TOKEN: PAT })), { texts: [] });
    await expect(handler(claimed(), jobContext)).rejects.toThrow("git_auth_unavailable");
    expect(sandbox.calls.find((c) => c.args.includes("clone"))).toBeUndefined();
  }, 30_000);

  it("C3: med eksplisitt PAT-fallback (JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK=true) brukes PAT-en fra env-kilden, og jobben fullføres", async () => {
    const github = stubGitHub({ failStatus: 404 });
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const auth = makeAuth(github, { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" });
    const result = await makeHandler(sandbox, auth.secretProvider(new MapSecrets({ JARVIS_GITHUB_TOKEN: PAT })), { texts: [] })(claimed(), jobContext);
    expect(result["tests"]).toBe("passed");
    expect(sandbox.calls.find((c) => c.args.includes("clone"))?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe(PAT);
    expect(auth.status().pat_fallback.active).toBe(true);
  }, 60_000);

  it("C4: PAT-modus (ingen App-konfig): secretProvider er den uendrede EnvSecretProvider-lignende kilden - clone/push får PAT som før", async () => {
    const source = new MapSecrets({ JARVIS_GITHUB_TOKEN: PAT });
    const auth = createGitHubAuth({ secrets: new MapSecrets({}), env: {}, log: () => undefined });
    expect(auth.secretProvider(source)).toBe(source);
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    await makeHandler(sandbox, auth.secretProvider(source), { texts: [] })(claimed(), jobContext);
    expect(sandbox.calls.find((c) => c.args.includes("clone"))?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe(PAT);
  }, 60_000);

  it("C5: withSecretRedaction med funksjon fjerner et installasjonstoken utstedt ETTER oppstart fra en kastet feilmelding", async () => {
    const github = stubGitHub();
    const auth = makeAuth(github);
    const token = await auth.secretProvider(new MapSecrets({})).get("JARVIS_GITHUB_TOKEN");
    expect(token).toBe(github.issued[0]);
    const leaky = async (): Promise<Record<string, unknown>> => { throw new Error(`push_failed: remote: invalid credentials ${token ?? ""} for repo`); };
    const wrapped = withSecretRedaction(leaky, () => ["unrelated", ...auth.knownTokens()]);
    await expect(wrapped(claimed(), jobContext)).rejects.toThrow("push_failed: remote: invalid credentials [REDACTED] for repo");
  });
});
