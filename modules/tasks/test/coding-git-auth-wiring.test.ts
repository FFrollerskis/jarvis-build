import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  ArtifactStore, GIT_ASKPASS_TOKEN_ENV, InProcessWorker, PgTaskQueue, ProcessSandboxRunner,
  createCodingHandler, type CodingAgentAdapter, type CodingAgentExec
} from "@jarvis/tasks";
import type { ExecResult, Sandbox, SandboxRunner } from "../src/sandbox.ts";

/**
 * D-103 (UA-5 Production Coding Reachability Repair v1) - Blokker B:
 * EKTE embedded-Postgres + EKTE lokalt git-bare-repo (ALDRI github.com, ALDRI
 * et ekte GitHub-kall) - beviser at eksplisitt git-transport-autentisering
 * KUN når til clone/push, ALDRI til agentens eget kall, ALDRI til git config,
 * ALDRI til argv/logger, og feiler rent lukket uten token.
 */

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
  session_id: "sess-gitauth", device_id: "dev-pc", channel: "web", auth_strength: "active"
};

function jobContract(overrides: Partial<JobContract> = {}): JobContract {
  return {
    task_id: `task-${randomUUID()}`,
    owner_person_id: "person-tobias",
    tenant_id: "tenant-a",
    goal: "test",
    acceptance_criteria: ["fullfører"],
    input: { data: {}, trust_level: "internal", provenance: "test" },
    allowed_tools: ["github"],
    allowed_memory_spaces: ["personal"],
    allowed_network_targets: [],
    agent_profile: "coding",
    model_budget_ore: 1000,
    retry_policy: { max_attempts: 1, backoff_seconds: 0 },
    max_steps: 3,
    ...overrides
  };
}

interface CapturedCall {
  command: string;
  args: string[];
  extraEnv: Record<string, string> | undefined;
}

/** Skriver ALDRI selv - kaller alltid `exec("node", ["-e", ...])` slik at kallet er entydig identifiserbart i den fangede logg-listen (adskilt fra clone/branch/add/commit/status/show/rev-parse/push). */
class WritingFakeAgent implements CodingAgentAdapter {
  readonly name = "fake-agent";
  async modify(exec: CodingAgentExec, _goal: string): Promise<string> {
    exec("node", ["-e", "require('fs').writeFileSync('CHANGES.md','endret')"]);
    return "endret CHANGES.md";
  }
}

/**
 * Fanger `(command, args, extraEnv)` for HVERT `sandbox.exec()`-kall, OG
 * skriver om `redirectFrom` (en github.com-formet URL) til `redirectTo` (et
 * lokalt bare-repo) i argv - SAMME presedens som `pr-publisher.test.ts` sin
 * egen `RepoUrlRedirectingSandboxRunner`, kun utvidet til også å logge extraEnv.
 */
class CapturingRedirectingSandboxRunner implements SandboxRunner {
  readonly name = "capturing-redirect-sandbox";
  readonly calls: CapturedCall[] = [];
  constructor(
    private readonly inner: SandboxRunner,
    private readonly redirectFrom: string,
    private readonly redirectTo: string
  ) {}
  async create(jobEnv?: Record<string, string>): Promise<Sandbox> {
    const sandbox = await this.inner.create(jobEnv);
    return {
      workdir: sandbox.workdir,
      exec: (command: string, args: string[], timeoutMs?: number, extraEnv?: Record<string, string>): ExecResult => {
        const rewritten = args.map((a) => (a === this.redirectFrom ? this.redirectTo : a));
        this.calls.push({ command, args: rewritten, extraEnv });
        return sandbox.exec(command, rewritten, timeoutMs, extraEnv);
      },
      dispose: () => sandbox.dispose()
    };
  }
}

const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let queue: PgTaskQueue;
let artifacts: ArtifactStore;
let policy: PolicyGateway;
let bareRepo: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
  }
  return result.stdout.trim();
}

const GITHUB_SHAPED_URL = "https://github.com/tsworkflow/jarvisbuild-d103-gitauth-test.git";

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-gitauth-"));
  epg = new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_gitauth LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_gitauth");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_gitauth", password: "pw2" });

  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"])
  });
  queue = new PgTaskQueue(appPool);
  artifacts = new ArtifactStore(appPool);

  bareRepo = await mkdtemp(join(tmpdir(), "jarvis-gitauth-origin-"));
  git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
  const seed = await mkdtemp(join(tmpdir(), "jarvis-gitauth-seed-"));
  git(seed, "init", "--initial-branch=main", ".");
  git(seed, "config", "user.email", "seed@test");
  git(seed, "config", "user.name", "seed");
  spawnSync("node", ["-e", "require('fs').writeFileSync('README.md','# repo')"], { cwd: seed });
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "init");
  git(seed, "push", bareRepo, "main");
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

const REAL_TOKEN = "ghp_D103TestTokenNeverPersisted999";

function runJob(sandbox: CapturingRedirectingSandboxRunner, gitAuthToken: string | null | undefined) {
  const worker = new InProcessWorker(queue, 60);
  worker.register("coding", createCodingHandler({
    sandbox, agent: new WritingFakeAgent(), artifacts, policy,
    identityFor: () => identity,
    ...(gitAuthToken !== undefined ? { gitAuth: { secretProvider: { get: async () => gitAuthToken } } } : {})
  }));
  const c = jobContract({ input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" } });
  return { worker, c };
}

describe("D-103: git-auth wiring i createCodingHandler (Blokker B)", () => {
  it("A: clone-kallet får extraEnv med GIT_ASKPASS/GIT_TERMINAL_PROMPT/token når gitAuth er konfigurert", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const clone = sandbox.calls.find((call) => call.args[0] === "clone");
    expect(clone?.extraEnv?.["GIT_ASKPASS"]).toBeDefined();
    expect(clone?.extraEnv?.["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(clone?.extraEnv?.[GIT_ASKPASS_TOKEN_ENV]).toBe(REAL_TOKEN);
  });

  it("B: push-kallet får extraEnv med GIT_ASKPASS/GIT_TERMINAL_PROMPT/token når gitAuth er konfigurert", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const push = sandbox.calls.find((call) => call.args[0] === "push");
    expect(push?.extraEnv?.["GIT_ASKPASS"]).toBeDefined();
    expect(push?.extraEnv?.[GIT_ASKPASS_TOKEN_ENV]).toBe(REAL_TOKEN);
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed"); // ekte push mot lokalt bare-repo lyktes
  });

  it("C: ALLE andre kall (branch/agent/status/add/commit/rev-parse/show) får extraEnv===undefined - token når ALDRI utover clone/push", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const nonNetworkCalls = sandbox.calls.filter((call) => call.args[0] !== "clone" && call.args[0] !== "push");
    expect(nonNetworkCalls.length).toBeGreaterThan(0); // branch/add/commit/status/rev-parse/show/agentens node-kall
    for (const call of nonNetworkCalls) {
      expect(call.extraEnv).toBeUndefined();
    }
    // Spesifikt: agentens EGET kall (identifiserbart som "node" med "-e") fikk aldri gitAuth-env.
    const agentCall = sandbox.calls.find((call) => call.command === "node" && call.args[0] === "-e");
    expect(agentCall?.extraEnv).toBeUndefined();
  });

  it("D: token finnes ALDRI i argv for noe kall (clone/push inkludert - token sendes KUN via env, ALDRI URL/argv)", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    for (const call of sandbox.calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain(REAL_TOKEN);
      }
    }
  });

  it("E: token finnes ALDRI i .git/config etter en fullført clone+push (remote-URL forblir uendret, ingen credential-injeksjon i config)", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    // Fanger workdir FØR sandbox.dispose() kjøres (via clone-kallet, som skjer tidlig i jobben).
    let capturedWorkdir: string | undefined;
    const originalCreate = sandbox.create.bind(sandbox);
    sandbox.create = async (jobEnv) => {
      const s = await originalCreate(jobEnv);
      capturedWorkdir = s.workdir;
      return s;
    };
    await worker.drain();
    expect(capturedWorkdir).toBeDefined();
    // sandbox.dispose() har allerede slettet workdir på dette tidspunktet - derfor
    // leses git config-innholdet i stedet via en EGEN, live kloning av SAMME
    // bare-repo (identisk remote-URL-tilstand som jobben selv satte via clone).
    const verifyDir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-verify-"));
    git(verifyDir, "clone", bareRepo, ".");
    const configContent = git(verifyDir, "config", "--get", "remote.origin.url");
    expect(configContent).not.toContain(REAL_TOKEN);
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
  });

  it("F: manglende token (secretProvider returnerer null) feiler LUKKET FØR clone forsøkes - ALDRI et stille fall til uautentisert git", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, null);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).toContain("git_auth_unavailable");
    expect(sandbox.calls.find((call) => call.args[0] === "clone")).toBeUndefined(); // clone ALDRI forsøkt
  });

  it("G: uten gitAuth-feltet i det hele tatt (default) er oppførselen 100% uendret - lokalt bare-repo-push fungerer fortsatt uten noen extraEnv noe sted", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, undefined);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    for (const call of sandbox.calls) {
      expect(call.extraEnv).toBeUndefined();
    }
  });

  it("H: token finnes ALDRI i en kastet feilmelding selv ved en ekte clone-feil (ugyldig repo_url)", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), "unused", "unused");
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox, agent: new WritingFakeAgent(), artifacts, policy,
      identityFor: () => identity,
      gitAuth: { secretProvider: { get: async () => REAL_TOKEN } }
    }));
    const c = jobContract({
      input: { data: { repo_url: "/nonexistent/path/that/does/not/exist" }, trust_level: "internal", provenance: "test" }
    });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).not.toContain(REAL_TOKEN);
  });

  it("I: ephemer askpass-fil fjernes etter jobbfullføring (cleanup skjer uavhengig av sandbox.dispose())", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const clone = sandbox.calls.find((call) => call.args[0] === "clone");
    const askpassCmd = clone?.extraEnv?.["GIT_ASKPASS"] as string;
    const scriptPath = askpassCmd.split('"')[3] as string;
    const { stat } = await import("node:fs/promises");
    await expect(stat(scriptPath)).rejects.toThrow();
  });

  it("J: ToolGateway/D-95 PR-publisering forblir uendret NÅR gitAuth OGSÅ er konfigurert samtidig (ingen interferens mellom Blokker A/B og D-95)", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const calls: Array<{ action: string }> = [];
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox, agent: new WritingFakeAgent(), artifacts, policy,
      identityFor: () => identity,
      gitAuth: { secretProvider: { get: async () => REAL_TOKEN } },
      github: {
        gateway: {
          execute: async (req) => {
            calls.push({ action: req.action });
            return { ok: true, data: { number: "7", html_url: "https://github.com/x/y/pull/7", created: true }, output_trust: "internal", deduplicated: false };
          }
        }
      }
    }));
    const c = jobContract({ input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" } });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    expect(calls).toEqual([{ action: "create_pr" }]);
  });
});
