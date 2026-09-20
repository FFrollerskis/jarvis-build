import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue, TrustLevel } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { ExecResult, Sandbox, SandboxRunner } from "@jarvis/tasks";
import type { PrPublishingGateway, ToolExecutionResult } from "@jarvis/tasks";
import type { CiStatus, SelfModificationGithubClient } from "../src/github-client.ts";
import { SelfModificationService } from "../src/service.ts";

/**
 * Task #121 (D-214): ende-til-ende-bevis for `SelfModificationService` mot
 * EKTE Postgres (`self_modification_requests`, migrasjon 060) - SAMME
 * embedded-postgres-mønster som `modules/owner-controls/test/
 * owner-control-authority.test.ts`. Sandbox/GitHub/PR-avhengighetene er
 * BEVISST faket (ingen ekte nettverk/git-binær nødvendig) - selve
 * git-KOMMANDOSEKVENSEN verifiseres strukturelt via `FakeSandbox.calls`.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const OWNER = "person-selfmod-owner";
const OTHER = "person-selfmod-other";

const ownerIdentity: IdentityContext = {
  person_id: OWNER, tenant_id: "tenant-personal", memory_space_id: "personal",
  session_id: "sess-selfmod", device_id: "jarvis-core", channel: "api", auth_strength: "active"
};
const otherIdentity: IdentityContext = { ...ownerIdentity, person_id: OTHER };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-selfmod-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leased.postgres;
  PORT = leased.port;
  stopEmbeddedPostgres = leased.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_selfmod_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_selfmod_test");
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Owner'), ('${OTHER}', 'Other')`);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_selfmod_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

beforeEach(async () => {
  await appPool.query("DELETE FROM self_modification_requests");
});

/** Bevisst FAKET - INGEN ekte git-binær/nettverk. Scripter svar per (command, argv[0]) og logger hvert kall for strukturell verifisering. */
/**
 * `netArgs()` (service.ts) prefikser `clone`/`push` med `-c <flag>`-par
 * (kredensial-isolasjon, se git-auth.ts) FØR selve subkommandoen - `args[0]`
 * er derfor "-c", ALDRI subkommandoen, for AKKURAT disse to kallene. Denne
 * hjelperen hopper over hvert `-c <verdi>`-par og returnerer den FAKTISKE
 * subkommandoen, uansett om kallet er nettverksautentisert eller ikke.
 */
function gitSubcommand(args: string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}

class FakeSandbox implements Sandbox {
  readonly workdir = "/fake/selfmod";
  calls: Array<{ command: string; args: string[]; extraEnv?: Record<string, string> }> = [];
  disposed = false;
  stagedPathsOverride: string | undefined;
  failOn: string | undefined;

  exec(command: string, args: string[], _timeoutMs?: number, extraEnv?: Record<string, string>): ExecResult {
    this.calls.push({ command, args, ...(extraEnv ? { extraEnv } : {}) });
    const key = `${command} ${command === "git" ? gitSubcommand(args) : (args[0] ?? "")}`;
    if (this.failOn && key.startsWith(this.failOn)) {
      return { code: 1, stdout: "", stderr: `simulated_failure:${key}` };
    }
    if (command === "git" && gitSubcommand(args) === "diff") {
      return { code: 0, stdout: this.stagedPathsOverride ?? "config/charlie-personality.json\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeSandboxRunner implements SandboxRunner {
  readonly name = "fake-selfmod-sandbox";
  lastSandbox: FakeSandbox | undefined;
  createCalls = 0;
  configure: (sandbox: FakeSandbox) => void = () => undefined;

  async create(): Promise<Sandbox> {
    this.createCalls++;
    const sandbox = new FakeSandbox();
    this.configure(sandbox);
    this.lastSandbox = sandbox;
    return sandbox;
  }
}

class FakePrGateway implements PrPublishingGateway {
  calls: Array<{ tool_id: string; action: string; parameters: Record<string, JsonValue> }> = [];
  prNumber = "42";
  ok = true;

  async execute(request: { tool_id: string; action: string; parameters: Record<string, JsonValue> }): Promise<ToolExecutionResult> {
    this.calls.push(request);
    if (!this.ok) return { ok: false, reason: "simulated_pr_publish_failure" };
    return {
      ok: true,
      external_id: this.prNumber,
      data: {
        number: this.prNumber,
        html_url: `https://github.com/tsworkflow/jarvisbuild/pull/${this.prNumber}`,
        created: true
      },
      output_trust: "internal" as TrustLevel,
      deduplicated: false
    };
  }
}

class FakeGithubClient implements SelfModificationGithubClient {
  ciStatus: CiStatus = "success";
  changedFiles: string[] = ["config/charlie-personality.json"];
  headSha = "deadbeef";
  mergeResult: { merged: boolean; message?: string } = { merged: true };
  throwOnCi = false;
  calls: string[] = [];

  async getCombinedCiStatus(_repo: string, _ref: string): Promise<CiStatus> {
    this.calls.push("ci_status");
    if (this.throwOnCi) throw new Error("simulated_ci_status_error");
    return this.ciStatus;
  }
  async getPullRequestChangedFiles(_repo: string, _prNumber: string): Promise<string[]> {
    this.calls.push("changed_files");
    return this.changedFiles;
  }
  async getPullRequestHeadSha(_repo: string, _prNumber: string): Promise<string> {
    this.calls.push("head_sha");
    return this.headSha;
  }
  async mergePullRequest(
    _repo: string,
    _prNumber: string,
    _opts: { sha: string; commitTitle: string }
  ): Promise<{ merged: boolean; message?: string }> {
    this.calls.push("merge");
    return this.mergeResult;
  }
}

function buildService(opts: {
  sandbox?: FakeSandboxRunner;
  githubClient?: FakeGithubClient;
  prGateway?: FakePrGateway;
  gitToken?: string | null;
}): { service: SelfModificationService; sandbox: FakeSandboxRunner; githubClient: FakeGithubClient; prGateway: FakePrGateway } {
  const sandbox = opts.sandbox ?? new FakeSandboxRunner();
  const githubClient = opts.githubClient ?? new FakeGithubClient();
  const prGateway = opts.prGateway ?? new FakePrGateway();
  const gitToken = opts.gitToken === undefined ? "fake-git-token" : opts.gitToken;
  const service = new SelfModificationService({
    pool: appPool,
    sandbox,
    resolveGitToken: async () => gitToken,
    githubClient,
    prGateway,
    ownerPersonId: OWNER,
    repoSlug: "tsworkflow/jarvisbuild",
    baseBranch: "main"
  });
  return { service, sandbox, githubClient, prGateway };
}

async function insertRequest(overrides: Partial<{
  request_id: string; risk: string; status: string; target_paths: string[]; branch: string; pr_number: string; pr_url: string;
}> = {}): Promise<string> {
  const requestId = overrides.request_id ?? `selfmod-${Math.random().toString(36).slice(2)}`;
  await appPool.query(
    `INSERT INTO self_modification_requests
       (request_id, kind, risk, target_paths, branch, pr_number, pr_url, status, requested_by_person_id, summary)
     VALUES ($1, 'personality_config', $2, $3, $4, $5, $6, $7, $8, 'test-seeded')`,
    [
      requestId,
      overrides.risk ?? "zero_review",
      overrides.target_paths ?? ["config/charlie-personality.json"],
      overrides.branch ?? "jarvis/self-mod/personality-test",
      overrides.pr_number ?? "42",
      overrides.pr_url ?? "https://github.com/tsworkflow/jarvisbuild/pull/42",
      overrides.status ?? "pending_ci",
      OWNER
    ]
  );
  return requestId;
}

describe("A: proposePersonalityChange - eier-kun, FØR noe git-arbeid", () => {
  it("A1: en ikke-eier-identitet kastes tilbake UTEN at sandbox i det hele tatt konstrueres", async () => {
    const { service, sandbox } = buildService({});
    await expect(
      service.proposePersonalityChange(otherIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_owner_only");
    expect(sandbox.createCalls).toBe(0);
  });

  it("A2: manglende git-token kastes FØR sandbox konstrueres (fail-closed, ingen stille uautentisert git)", async () => {
    const { service, sandbox } = buildService({ gitToken: null });
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_git_auth_unavailable");
    expect(sandbox.createCalls).toBe(0);
  });

  it("A3: ugyldig input (tomme style_notes) kastes av skjemaet FØR sandbox konstrueres", async () => {
    const { service, sandbox } = buildService({});
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "" })
    ).rejects.toThrow();
    expect(sandbox.createCalls).toBe(0);
  });

  it("A4: for mange tone_descriptors (>6) avvises av skjemaet", async () => {
    const { service, sandbox } = buildService({});
    await expect(
      service.proposePersonalityChange(ownerIdentity, {
        tone_descriptors: ["a", "b", "c", "d", "e", "f", "g"],
        style_notes: "test"
      })
    ).rejects.toThrow();
    expect(sandbox.createCalls).toBe(0);
  });
});

describe("B: proposePersonalityChange - lykkes-banen", () => {
  it("B1: riktig git-kommandosekvens, PR opprettet, DB-rad satt inn med status pending_ci", async () => {
    const { service, sandbox, prGateway } = buildService({});
    const result = await service.proposePersonalityChange(ownerIdentity, {
      tone_descriptors: ["varm", "leken"],
      style_notes: "Litt mer avslappet."
    });

    expect(result.risk).toBe("zero_review");
    expect(result.pr_number).toBe("42");
    expect(result.branch).toMatch(/^jarvis\/self-mod\/personality-\d+$/);

    const calls = sandbox.lastSandbox!.calls;
    const commands = calls.map((c) => `${c.command} ${c.command === "git" ? gitSubcommand(c.args) : (c.args[0] ?? "")}`);
    expect(commands).toEqual(["git clone", "git checkout", "node -e", "git add", "git diff", "git commit", "git push"]);
    expect(sandbox.lastSandbox!.disposed).toBe(true);

    expect(prGateway.calls).toHaveLength(1);
    expect(prGateway.calls[0]?.tool_id).toBe("github");
    expect(prGateway.calls[0]?.action).toBe("create_pr");
    expect(prGateway.calls[0]?.parameters["repo"]).toBe("tsworkflow/jarvisbuild");

    const row = await appPool.query("SELECT * FROM self_modification_requests WHERE request_id = $1", [result.request_id]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].status).toBe("pending_ci");
    expect(row.rows[0].risk).toBe("zero_review");
    expect(row.rows[0].target_paths).toEqual(["config/charlie-personality.json"]);
    expect(row.rows[0].requested_by_person_id).toBe(OWNER);
  });

  it("B2: commit-meldingen inneholder identitetens person_id (proveniens)", async () => {
    const { service, sandbox } = buildService({});
    await service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" });
    const commitCall = sandbox.lastSandbox!.calls.find((c) => c.command === "git" && c.args[0] === "commit");
    expect(commitCall?.args.join(" ")).toContain(OWNER);
  });

  it("B3: push-target matcher den genererte branchen (branch:branch)", async () => {
    const { service, sandbox } = buildService({});
    const result = await service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" });
    const pushCall = sandbox.lastSandbox!.calls.find((c) => c.command === "git" && gitSubcommand(c.args) === "push");
    expect(pushCall?.args).toContain(`${result.branch}:${result.branch}`);
  });
});

describe("C: proposePersonalityChange - feilbaner underveis i git-arbeidet", () => {
  it("C1: uventet staged path (feil fil committet) kastes, INGEN DB-rad, sandbox disposes uansett", async () => {
    const sandbox = new FakeSandboxRunner();
    sandbox.configure = (s) => { s.stagedPathsOverride = "some/other/file.ts\n"; };
    const { service } = buildService({ sandbox });
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_unexpected_staged_paths");
    expect(sandbox.lastSandbox!.disposed).toBe(true);
    const rows = await appPool.query("SELECT * FROM self_modification_requests");
    expect(rows.rows).toHaveLength(0);
  });

  it("C2: git clone feiler -> kastes med clone_failed, sandbox disposes uansett, INGEN DB-rad", async () => {
    const sandbox = new FakeSandboxRunner();
    sandbox.configure = (s) => { s.failOn = "git clone"; };
    const { service } = buildService({ sandbox });
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_clone_failed");
    expect(sandbox.lastSandbox!.disposed).toBe(true);
    const rows = await appPool.query("SELECT * FROM self_modification_requests");
    expect(rows.rows).toHaveLength(0);
  });

  it("C3: PR-publisering feiler -> kastes, sandbox likevel disposet, INGEN DB-rad", async () => {
    const prGateway = new FakePrGateway();
    prGateway.ok = false;
    const { service, sandbox } = buildService({ prGateway });
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_pr_publish_failed");
    expect(sandbox.lastSandbox!.disposed).toBe(true);
    const rows = await appPool.query("SELECT * FROM self_modification_requests");
    expect(rows.rows).toHaveLength(0);
  });
});

describe("D: sweepPendingRequests - CI-portvakten", () => {
  it("D1: CI pending -> raden forblir pending_ci, rapportert i still_pending", async () => {
    const requestId = await insertRequest();
    const githubClient = new FakeGithubClient();
    githubClient.ciStatus = "pending";
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    expect(outcome.still_pending).toEqual([requestId]);
    expect(outcome.merged).toEqual([]);
    expect(githubClient.calls).toEqual(["ci_status"]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("pending_ci");
  });

  it("D2: CI failure -> markert ci_failed, rapportert i failed", async () => {
    const requestId = await insertRequest();
    const githubClient = new FakeGithubClient();
    githubClient.ciStatus = "failure";
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    expect(outcome.failed).toEqual([requestId]);
    const row = await appPool.query("SELECT status, resolved_at FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("ci_failed");
    expect(row.rows[0].resolved_at).not.toBeNull();
  });

  it("D3: CI success + diff matcher eksakt + zero_review -> merges, status merged", async () => {
    const requestId = await insertRequest();
    const { service, githubClient } = buildService({});
    const outcome = await service.sweepPendingRequests();
    expect(outcome.merged).toEqual([requestId]);
    expect(githubClient.calls).toEqual(["ci_status", "changed_files", "head_sha", "merge"]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("merged");
  });

  it("D4: CI success men PR-diffen har VOKST (mer enn target_paths) -> ci_failed, ALDRI merge", async () => {
    const requestId = await insertRequest();
    const githubClient = new FakeGithubClient();
    githubClient.changedFiles = ["config/charlie-personality.json", "modules/policy/src/gateway.ts"];
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    expect(outcome.failed).toEqual([requestId]);
    expect(githubClient.calls).not.toContain("merge");
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("ci_failed");
  });

  it("D5: mergePullRequest returnerer merged:false (f.eks. stale sha) -> forblir pending_ci, prøves igjen senere", async () => {
    const requestId = await insertRequest();
    const githubClient = new FakeGithubClient();
    githubClient.mergeResult = { merged: false, message: "405" };
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    expect(outcome.still_pending).toEqual([requestId]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("pending_ci");
  });

  it("D6: en allerede merged rad røres ikke igjen (sweepen spør kun status=pending_ci)", async () => {
    const requestId = await insertRequest({ status: "merged" });
    const { service, githubClient } = buildService({});
    const outcome = await service.sweepPendingRequests();
    expect(outcome.merged).not.toContain(requestId);
    expect(outcome.failed).not.toContain(requestId);
    expect(outcome.still_pending).not.toContain(requestId);
    expect(githubClient.calls).toEqual([]);
  });

  it("D7: én rads uventede feil (GitHub-klienten kaster) stjeler ikke resten av sveipen - isolert per rad", async () => {
    const brokenId = await insertRequest();
    const okId = await insertRequest();
    const githubClient = new FakeGithubClient();
    const original = githubClient.getCombinedCiStatus.bind(githubClient);
    let call = 0;
    githubClient.getCombinedCiStatus = async (repo: string, ref: string) => {
      call++;
      if (call === 1) throw new Error("simulated_transient_error");
      return original(repo, ref);
    };
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    // Rekkefølgen er `ORDER BY created_at` - begge radene ble satt inn i
    // rekkefølge, så den FØRSTE (brokenId) feiler og forblir pending
    // (try/catch-isolasjon), den ANDRE (okId) merges uendret.
    expect(outcome.still_pending).toContain(brokenId);
    expect(outcome.merged).toContain(okId);
  });
});

describe("E: resolveApproval - Telegram-godkjennings-tilstandsmaskinen", () => {
  it("E1: godkjenning av en awaiting_approval-rad -> approved, resolved_by satt", async () => {
    const requestId = await insertRequest({ risk: "requires_approval", status: "awaiting_approval" });
    const { service } = buildService({});
    const updated = await service.resolveApproval(requestId, "approved", OWNER);
    expect(updated.status).toBe("approved");
    expect(updated.resolved_by_person_id).toBe(OWNER);
    expect(updated.resolved_at).not.toBeNull();
  });

  it("E2: avvisning av en awaiting_approval-rad -> rejected", async () => {
    const requestId = await insertRequest({ risk: "requires_approval", status: "awaiting_approval" });
    const { service } = buildService({});
    const updated = await service.resolveApproval(requestId, "rejected", OWNER);
    expect(updated.status).toBe("rejected");
  });

  it("E3: ukjent request_id kastes", async () => {
    const { service } = buildService({});
    await expect(service.resolveApproval("selfmod-does-not-exist", "approved", OWNER)).rejects.toThrow(
      "self_modification_request_not_found"
    );
  });

  it("E4: en rad som IKKE er awaiting_approval (f.eks. pending_ci) kan ikke godkjennes", async () => {
    const requestId = await insertRequest({ status: "pending_ci" });
    const { service } = buildService({});
    await expect(service.resolveApproval(requestId, "approved", OWNER)).rejects.toThrow(
      "self_modification_request_not_awaiting_approval:pending_ci"
    );
  });

  it("E5: en allerede approved rad kan ikke godkjennes på nytt (ingen dobbel-overgang)", async () => {
    const requestId = await insertRequest({ risk: "requires_approval", status: "awaiting_approval" });
    const { service } = buildService({});
    await service.resolveApproval(requestId, "approved", OWNER);
    await expect(service.resolveApproval(requestId, "approved", OWNER)).rejects.toThrow(
      "self_modification_request_not_awaiting_approval:approved"
    );
  });
});

describe("F: getRequest", () => {
  it("F1: ukjent id -> null", async () => {
    const { service } = buildService({});
    expect(await service.getRequest("selfmod-does-not-exist")).toBeNull();
  });

  it("F2: kjent id -> full, mappet rad", async () => {
    const requestId = await insertRequest();
    const { service } = buildService({});
    const found = await service.getRequest(requestId);
    expect(found?.request_id).toBe(requestId);
    expect(found?.status).toBe("pending_ci");
    expect(found?.target_paths).toEqual(["config/charlie-personality.json"]);
  });
});
