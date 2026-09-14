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
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  ArtifactStore, InProcessWorker, PgTaskQueue, ProcessSandboxRunner,
  ScriptedCodingAgent, createCodingHandler
} from "@jarvis/tasks";
import type { Sandbox, SandboxRunner } from "../src/sandbox.ts";
import {
  parseGithubRepoSlug, publishPullRequestForCodingJob,
  type PrPublishingGateway, type ToolExecutionResult
} from "../src/pr-publisher.ts";

/**
 * UA-5 Tested Fix Orchestrator v1 (D-95) test matrix:
 * A-K: rene enhetstester (ingen DB) for parseGithubRepoSlug/publishPullRequestForCodingJob.
 * L-P: kablingstester (ekte embedded-Postgres, ekte git-bare-repo) for createCodingHandler
 * sin nye valgfrie `github`-avhengighet.
 */

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
  session_id: "sess-pr", device_id: "dev-pc", channel: "web", auth_strength: "active"
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

class FakeGithubGateway implements PrPublishingGateway {
  readonly calls: Array<{ tool_id: string; action: string; parameters: Record<string, unknown>; idempotency_key?: string; jobContract?: JobContract }> = [];
  constructor(private readonly response: ToolExecutionResult) {}
  async execute(request: Parameters<PrPublishingGateway["execute"]>[0]): Promise<ToolExecutionResult> {
    this.calls.push({
      tool_id: request.tool_id, action: request.action, parameters: request.parameters,
      ...(request.idempotency_key !== undefined ? { idempotency_key: request.idempotency_key } : {}),
      ...(request.jobContract !== undefined ? { jobContract: request.jobContract } : {})
    });
    return this.response;
  }
}

describe("A-D: parseGithubRepoSlug", () => {
  it("A: https-URL uten .git", () => {
    expect(parseGithubRepoSlug("https://github.com/tsworkflow/jarvisbuild")).toBe("tsworkflow/jarvisbuild");
  });
  it("B: https-URL med .git-suffiks", () => {
    expect(parseGithubRepoSlug("https://github.com/tsworkflow/jarvisbuild.git")).toBe("tsworkflow/jarvisbuild");
  });
  it("C: ssh-URL", () => {
    expect(parseGithubRepoSlug("git@github.com:tsworkflow/jarvisbuild.git")).toBe("tsworkflow/jarvisbuild");
  });
  it("D: ikke-GitHub-URL (lokal bare-repo-sti) gir null, kaster aldri", () => {
    expect(parseGithubRepoSlug("/tmp/jarvis-origin-abc123")).toBeNull();
  });
});

describe("E-K: publishPullRequestForCodingJob (ren logikk, ingen DB)", () => {
  const baseParams = {
    identity,
    branch: "jarvis/task-1",
    base: "main",
    title: "jarvis: fiks",
    body: "beskrivelse"
  };

  it("E: uparsbar repo-URL hopper over PR-forsøket UTEN å kalle gateway", async () => {
    const gateway = new FakeGithubGateway({ ok: true, output_trust: "internal", deduplicated: false });
    const result = await publishPullRequestForCodingJob({
      ...baseParams, gateway, jobContract: jobContract(), repoUrl: "/tmp/local-bare-repo"
    });
    expect(result.status).toBe("skipped_unparseable_repo");
    expect(gateway.calls).toHaveLength(0);
  });

  it("F: 'github' mangler i jobContract.allowed_tools hopper over UTEN å kalle gateway", async () => {
    const gateway = new FakeGithubGateway({ ok: true, output_trust: "internal", deduplicated: false });
    const result = await publishPullRequestForCodingJob({
      ...baseParams, gateway, jobContract: jobContract({ allowed_tools: [] }),
      repoUrl: "https://github.com/tsworkflow/jarvisbuild"
    });
    expect(result.status).toBe("skipped_not_allowed");
    expect(gateway.calls).toHaveLength(0);
  });

  it("G: kaller gateway.execute med github/create_pr, korrekte parametre, deterministisk idempotency_key og videreført jobContract", async () => {
    const gateway = new FakeGithubGateway({ ok: true, data: { number: "7", html_url: "https://github.com/x/y/pull/7", created: true }, output_trust: "internal", deduplicated: false });
    const contract = jobContract();
    await publishPullRequestForCodingJob({ ...baseParams, gateway, jobContract: contract, repoUrl: "https://github.com/tsworkflow/jarvisbuild" });
    expect(gateway.calls).toHaveLength(1);
    const call = gateway.calls[0]!;
    expect(call.tool_id).toBe("github");
    expect(call.action).toBe("create_pr");
    expect(call.parameters).toEqual({ repo: "tsworkflow/jarvisbuild", branch: "jarvis/task-1", title: "jarvis: fiks", base: "main", body: "beskrivelse" });
    expect(call.idempotency_key).toBe(`coding-job-pr:${contract.task_id}`);
    expect(call.jobContract).toBe(contract);
  });

  it("H: ok+created=true gir status 'created' med pr_number/pr_url", async () => {
    const gateway = new FakeGithubGateway({ ok: true, data: { number: "7", html_url: "https://github.com/x/y/pull/7", created: true }, output_trust: "internal", deduplicated: false });
    const result = await publishPullRequestForCodingJob({ ...baseParams, gateway, jobContract: jobContract(), repoUrl: "https://github.com/tsworkflow/jarvisbuild" });
    expect(result).toEqual({ status: "created", repo: "tsworkflow/jarvisbuild", pr_number: "7", pr_url: "https://github.com/x/y/pull/7" });
  });

  it("I: ok+created=false (eksisterende PR funnet) gir status 'found_existing'", async () => {
    const gateway = new FakeGithubGateway({ ok: true, data: { number: "3", html_url: "https://github.com/x/y/pull/3", created: false }, output_trust: "internal", deduplicated: false });
    const result = await publishPullRequestForCodingJob({ ...baseParams, gateway, jobContract: jobContract(), repoUrl: "https://github.com/tsworkflow/jarvisbuild" });
    expect(result.status).toBe("found_existing");
    expect(result.pr_number).toBe("3");
  });

  it("J: deduplicated=true (retry etter tidligere suksess) gir 'already_published' fra external_id - stoler IKKE på data (finnes ikke ved dedupe-treff)", async () => {
    const gateway = new FakeGithubGateway({ ok: true, external_id: "9", output_trust: "internal", deduplicated: true });
    const result = await publishPullRequestForCodingJob({ ...baseParams, gateway, jobContract: jobContract(), repoUrl: "https://github.com/tsworkflow/jarvisbuild" });
    expect(result).toEqual({ status: "already_published", repo: "tsworkflow/jarvisbuild", pr_number: "9" });
  });

  it("K: gateway ok=false gir status 'failed' med reason - kaster ALDRI", async () => {
    const gateway = new FakeGithubGateway({ ok: false, reason: "connector_frozen" });
    const result = await publishPullRequestForCodingJob({ ...baseParams, gateway, jobContract: jobContract(), repoUrl: "https://github.com/tsworkflow/jarvisbuild" });
    expect(result).toEqual({ status: "failed", repo: "tsworkflow/jarvisbuild", reason: "connector_frozen" });
  });

  it("P: aldri kaller merge_pr eller andre github-handlinger enn create_pr, uansett utfall", async () => {
    const scenarios: ToolExecutionResult[] = [
      { ok: true, data: { number: "1", html_url: "u", created: true }, output_trust: "internal", deduplicated: false },
      { ok: false, reason: "x" },
      { ok: true, external_id: "1", output_trust: "internal", deduplicated: true }
    ];
    for (const response of scenarios) {
      const gateway = new FakeGithubGateway(response);
      await publishPullRequestForCodingJob({ ...baseParams, gateway, jobContract: jobContract(), repoUrl: "https://github.com/tsworkflow/jarvisbuild" });
      expect(gateway.calls.every((c) => c.action === "create_pr")).toBe(true);
    }
  });
});

describe("L-O: createCodingHandler + github-avhengighet (ekte embedded-Postgres + git)", () => {
  let PORT = 0;
  let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let queue: PgTaskQueue;
  let artifacts: ArtifactStore;
  let policy: PolicyGateway;
  let bareRepo: string;

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
    return result.stdout.trim();
  }

  /**
   * Testmiljøet har ingen ekte tilgang til github.com (og SKAL aldri klone/
   * pushe mot det VIRKELIGE jarvisbuild-repoet fra en test). Denne wrapperen
   * lar `input.repo_url` være en ekte github.com-formet streng (slik at
   * `parseGithubRepoSlug` - og dermed hele PR-kall-veien - faktisk trigges
   * ende-til-ende), mens SELVE `git clone`-kommandoen skrives om til det
   * lokale bare-repoet. `git push origin ...` etterpå rammes ikke (origin
   * er allerede satt til det omskrevne målet av selve clonen) - ingen annen
   * oppførsel i coding.ts endres eller mockes.
   */
  class RepoUrlRedirectingSandboxRunner implements SandboxRunner {
    readonly name = "redirect-sandbox";
    constructor(
      private readonly inner: SandboxRunner,
      private readonly redirectFrom: string,
      private readonly redirectTo: string
    ) {}
    async create(jobEnv?: Record<string, string>): Promise<Sandbox> {
      const sandbox = await this.inner.create(jobEnv);
      return {
        workdir: sandbox.workdir,
        exec: (command, args, timeoutMs) =>
          sandbox.exec(command, args.map((a) => (a === this.redirectFrom ? this.redirectTo : a)), timeoutMs),
        dispose: () => sandbox.dispose()
      };
    }
  }

  beforeAll(async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-pr-"));
    const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
      new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false })
    );
    epg = leasedPostgres.postgres;
    PORT = leasedPostgres.port;
    stopEmbeddedPostgres = leasedPostgres.stop;
    await epg.createDatabase("jarvis_test");
    adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
    adminPool.on("error", () => undefined);
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_test_pr LOGIN PASSWORD 'pw2'");
    await adminPool.query("GRANT jarvis_app TO jarvis_test_pr");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
      INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
    `);
    appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_pr", password: "pw2" });

    policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(),
      killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"])
    });
    queue = new PgTaskQueue(appPool);
    artifacts = new ArtifactStore(appPool);

    bareRepo = await mkdtemp(join(tmpdir(), "jarvis-pr-origin-"));
    git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
    const seed = await mkdtemp(join(tmpdir(), "jarvis-pr-seed-"));
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
    await stopEmbeddedPostgres?.();
  }, 120_000);

  const GITHUB_SHAPED_URL = "https://github.com/tsworkflow/jarvisbuild.git";

  function runCodingJob(overrides: {
    github?: { gateway: PrPublishingGateway; base?: string };
    allowedTools?: string[];
    repoUrl?: string;
    sandbox?: SandboxRunner;
  }) {
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox: overrides.sandbox ?? new ProcessSandboxRunner(), agent: new ScriptedCodingAgent(), artifacts, policy,
      identityFor: () => identity,
      ...(overrides.github ? { github: overrides.github } : {})
    }));
    const c = jobContract({
      input: { data: { repo_url: overrides.repoUrl ?? bareRepo }, trust_level: "internal", provenance: "test" },
      allowed_tools: overrides.allowedTools ?? ["github"]
    });
    return { worker, c };
  }

  it("L: github konfigurert + tillatt + github.com-formet repo -> PR opprettes ende-til-ende, commit_sha og pr i resultatet, pr-result-artefakt lagret", async () => {
    const gateway = new FakeGithubGateway({ ok: true, data: { number: "42", html_url: "https://github.com/tsworkflow/jarvisbuild/pull/42", created: true }, output_trust: "internal", deduplicated: false });
    const sandbox = new RepoUrlRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runCodingJob({ github: { gateway }, repoUrl: GITHUB_SHAPED_URL, sandbox });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    const result = view?.result as { commit_sha: string; pr: { status: string; pr_number?: string } };
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.pr).toEqual({ status: "created", repo: "tsworkflow/jarvisbuild", pr_number: "42", pr_url: "https://github.com/tsworkflow/jarvisbuild/pull/42" });
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.action).toBe("create_pr");
    const saved = await artifacts.list("tenant-a", c.task_id);
    const prResult = saved.find((a) => a.kind === "pr-result");
    expect(prResult && JSON.parse(prResult.content)).toEqual(result.pr);
  });

  it("M: github konfigurert men IKKE i allowed_tools -> jobben fullfører likevel; pr.status='skipped_not_allowed'; gateway aldri kalt (sjekkes FØR repo-parsing)", async () => {
    const gateway = new FakeGithubGateway({ ok: true, data: { number: "1", html_url: "u", created: true }, output_trust: "internal", deduplicated: false });
    const { worker, c } = runCodingJob({ github: { gateway }, allowedTools: [] });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    const result = view?.result as { pr: { status: string } };
    expect(result.pr.status).toBe("skipped_not_allowed");
    expect(gateway.calls).toHaveLength(0);
  });

  it("N: uten github-avhengighet i det hele tatt (uendret pre-D-95-oppførsel) -> intet pr-felt, men commit_sha finnes", async () => {
    const { worker, c } = runCodingJob({});
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    const result = view?.result as { commit_sha: string; pr?: unknown };
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.pr).toBeUndefined();
    const kinds = (await artifacts.list("tenant-a", c.task_id)).map((a) => a.kind).sort();
    expect(kinds).toEqual(["patch", "pr-proposal", "test-log"]);
  });

  it("O: GitHub-feil (f.eks. frosset connector) gjør ALDRI en fullført test+push-jobb til 'failed' - feilen er synlig i pr.status, aldri skjult", async () => {
    const gateway = new FakeGithubGateway({ ok: false, reason: "connector_frozen" });
    const sandbox = new RepoUrlRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runCodingJob({ github: { gateway }, repoUrl: GITHUB_SHAPED_URL, sandbox });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    const result = view?.result as { pr: { status: string; reason?: string } };
    expect(result.pr).toEqual({ status: "failed", repo: "tsworkflow/jarvisbuild", reason: "connector_frozen" });
  });
});
