import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ArtifactStore, ClaudeCodeAgent, InProcessWorker, PgTaskQueue, ProcessSandboxRunner, createCodingHandler } from "@jarvis/tasks";
import type { CodingAgentExec } from "../src/coding.ts";

/**
 * D-96 Real Coding Agent v1 test matrix:
 * A-K: rene enhetstester (ingen DB, ingen ekte prosess) for ClaudeCodeAgent.modify().
 * L-O: kablingstester (ekte embedded-Postgres + ekte sandbox-prosess-kjøring av en
 * fake `claude`-binær som etterligner den dokumenterte CLI-kontrakten - JARVIS_CLAUDE_BIN
 * er IKKE konfigurert i dette miljøet, så en ekte binær kan strukturelt ikke kjøres her;
 * fake-binæren beviser wiring-korrekthet, IKKE modellkvalitet - se D-96 for full begrunnelse).
 */

function fakeExec(response: { code: number; stdout: string; stderr: string }) {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs?: number }> = [];
  const exec: CodingAgentExec = (cmd, args, timeoutMs) => {
    calls.push({ cmd, args, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    return response;
  };
  return { exec, calls };
}

describe("A-K: ClaudeCodeAgent.modify() (ren logikk, ingen ekte prosess)", () => {
  it("A: bin ikke konfigurert -> claude_code_not_configured, exec kalles aldri", async () => {
    const agent = new ClaudeCodeAgent(undefined);
    const { exec, calls } = fakeExec({ code: 0, stdout: "{}", stderr: "" });
    await expect(agent.modify(exec, "fiks bug")).rejects.toThrow("claude_code_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("B: bygger korrekt, dokumentert flaggsett (-p/--bare/--output-format json/--permission-mode acceptEdits/--allowedTools Read,Edit)", async () => {
    const agent = new ClaudeCodeAgent("/usr/local/bin/claude");
    const { exec, calls } = fakeExec({ code: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "" });
    await agent.modify(exec, "fiks autentiseringsbug");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("/usr/local/bin/claude");
    expect(calls[0]!.args).toEqual([
      "-p", "fiks autentiseringsbug",
      "--bare",
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit"
    ]);
  });

  it("C: bruker default timeout 300000ms", async () => {
    const agent = new ClaudeCodeAgent("/bin/claude");
    const { exec, calls } = fakeExec({ code: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "" });
    await agent.modify(exec, "mål");
    expect(calls[0]!.timeoutMs).toBe(300_000);
  });

  it("D: egendefinert timeout i konstruktør respekteres", async () => {
    const agent = new ClaudeCodeAgent("/bin/claude", 60_000);
    const { exec, calls } = fakeExec({ code: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "" });
    await agent.modify(exec, "mål");
    expect(calls[0]!.timeoutMs).toBe(60_000);
  });

  it("E: exit 0 + gyldig JSON {result} -> returnerer result-teksten", async () => {
    const agent = new ClaudeCodeAgent("/bin/claude");
    const { exec } = fakeExec({ code: 0, stdout: JSON.stringify({ result: "La til null-sjekk i auth.py" }), stderr: "" });
    await expect(agent.modify(exec, "fiks")).resolves.toBe("La til null-sjekk i auth.py");
  });

  it("F: exit 0 + ikke-JSON stdout -> faller tilbake til rå, trimmet stdout", async () => {
    const agent = new ClaudeCodeAgent("/bin/claude");
    const { exec } = fakeExec({ code: 0, stdout: "  ren tekst, ikke JSON  \n", stderr: "" });
    await expect(agent.modify(exec, "fiks")).resolves.toBe("ren tekst, ikke JSON");
  });

  it("G: exit 0 + tomt/whitespace-only stdout -> claude_code_cli_invalid_output", async () => {
    const agent = new ClaudeCodeAgent("/bin/claude");
    const { exec } = fakeExec({ code: 0, stdout: "   \n  ", stderr: "" });
    await expect(agent.modify(exec, "fiks")).rejects.toThrow("claude_code_cli_invalid_output");
  });

  it("H: exit 0 + gyldig JSON men result mangler/er tom -> claude_code_cli_invalid_output (IKKE stille suksess)", async () => {
    const agent = new ClaudeCodeAgent("/bin/claude");
    const { exec: exec1 } = fakeExec({ code: 0, stdout: JSON.stringify({ session_id: "x" }), stderr: "" });
    await expect(agent.modify(exec1, "fiks")).rejects.toThrow("claude_code_cli_invalid_output");
    const { exec: exec2 } = fakeExec({ code: 0, stdout: JSON.stringify({ result: "" }), stderr: "" });
    await expect(agent.modify(exec2, "fiks")).rejects.toThrow("claude_code_cli_invalid_output");
  });

  it("I: exit != 0 + stderr -> claude_code_cli_failed:<stderr, avkortet 300 tegn>", async () => {
    const agent = new ClaudeCodeAgent("/bin/claude");
    const { exec } = fakeExec({ code: 1, stdout: "", stderr: "authentication_error: invalid api key" });
    await expect(agent.modify(exec, "fiks")).rejects.toThrow("claude_code_cli_failed:authentication_error: invalid api key");
  });

  it("J: exit != 0 + tom stderr men stdout finnes -> faller tilbake til stdout i feilmeldingen", async () => {
    const agent = new ClaudeCodeAgent("/bin/claude");
    const { exec } = fakeExec({ code: 1, stdout: "fatal: could not resolve model", stderr: "" });
    await expect(agent.modify(exec, "fiks")).rejects.toThrow("claude_code_cli_failed:fatal: could not resolve model");
  });

  it("K: kaller ALDRI med Bash i allowedTools, uansett scenario", async () => {
    const agent = new ClaudeCodeAgent("/bin/claude");
    const { exec, calls } = fakeExec({ code: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "" });
    await agent.modify(exec, "mål");
    const allowedToolsIndex = calls[0]!.args.indexOf("--allowedTools");
    expect(calls[0]!.args[allowedToolsIndex + 1]).toBe("Read,Edit");
    expect(calls[0]!.args.join(" ")).not.toContain("Bash");
  });
});

describe("L-O: ClaudeCodeAgent via createCodingHandler (ekte embedded-Postgres + ekte sandbox-prosesskjøring)", () => {
  const PORT = allocateEmbeddedPostgresPort();
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let queue: PgTaskQueue;
  let artifacts: ArtifactStore;
  let policy: PolicyGateway;
  let bareRepo: string;
  let fakeClaudeBin: string;

  const identity: IdentityContext = {
    person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
    session_id: "sess-cc", device_id: "dev-pc", channel: "web", auth_strength: "active"
  };

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
    return result.stdout.trim();
  }

  function jobContract(overrides: Partial<JobContract> = {}): JobContract {
    return {
      task_id: `task-${randomUUID()}`,
      owner_person_id: "person-tobias",
      tenant_id: "tenant-a",
      goal: "fiks null-sjekk",
      acceptance_criteria: ["fullfører"],
      input: { data: { repo_url: bareRepo }, trust_level: "internal", provenance: "test" },
      allowed_tools: [],
      allowed_memory_spaces: ["personal"],
      allowed_network_targets: [],
      agent_profile: "coding",
      model_budget_ore: 1000,
      retry_policy: { max_attempts: 1, backoff_seconds: 0 },
      max_steps: 3,
      ...overrides
    };
  }

  beforeAll(async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-cc-"));
    epg = new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port: PORT, persistent: false });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("jarvis_test");
    adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
    adminPool.on("error", () => undefined);
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_test_cc LOGIN PASSWORD 'pw2'");
    await adminPool.query("GRANT jarvis_app TO jarvis_test_cc");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
      INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
    `);
    appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_cc", password: "pw2" });

    policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(),
      killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"])
    });
    queue = new PgTaskQueue(appPool);
    artifacts = new ArtifactStore(appPool);

    bareRepo = await mkdtemp(join(tmpdir(), "jarvis-cc-origin-"));
    git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
    const seed = await mkdtemp(join(tmpdir(), "jarvis-cc-seed-"));
    git(seed, "init", "--initial-branch=main", ".");
    git(seed, "config", "user.email", "seed@test");
    git(seed, "config", "user.name", "seed");
    spawnSync("node", ["-e", "require('fs').writeFileSync('README.md','# repo')"], { cwd: seed });
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "init");
    git(seed, "push", bareRepo, "main");

    // Fake `claude`-binær (etterligner den dokumenterte -p/--output-format json-kontrakten).
    // Scenario styres via et "SCENARIO:<navn>"-prefiks i selve MÅL-teksten (`-p <goal>`) -
    // IKKE via en test-prosess-env-variabel, siden ProcessSandboxRunner med hensikt IKKE
    // arver process.env inn i sandbox-barneprosessen (kun PATH + git-identitet + eksplisitt
    // jobEnv) - en env-basert testkanal ville derfor aldri nådd frem. JARVIS_CLAUDE_BIN er
    // IKKE konfigurert i dette miljøet - dette beviser wiring-korrekthet, ALDRI ekte
    // modellkvalitet.
    const binDir = mkdtempSync(join(tmpdir(), "jarvis-fake-claude-"));
    fakeClaudeBin = join(binDir, "fake-claude.js");
    writeFileSync(fakeClaudeBin, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const promptIndex = args.indexOf("-p");
const goal = promptIndex >= 0 ? args[promptIndex + 1] : "";
const scenario = goal.startsWith("SCENARIO:") ? goal.slice("SCENARIO:".length).split(" ")[0] : "success";
if (scenario === "requires_key" && !process.env["ANTHROPIC_API_KEY"]) {
  process.stderr.write("authentication_error: ANTHROPIC_API_KEY not set");
  process.exit(1);
}
if (scenario === "fail") {
  process.stderr.write("simulated_cli_failure");
  process.exit(1);
}
fs.writeFileSync("FIX.md", "# Fix for: " + goal + "\\n");
process.stdout.write(JSON.stringify({ result: "Fixed: " + goal, session_id: "fake-session" }));
process.exit(0);
`);
    chmodSync(fakeClaudeBin, 0o755);
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    await epg?.stop();
  }, 120_000);

  function runCodingJob(overrides: { goal?: string; claudeCodeCredential?: boolean }) {
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox: new ProcessSandboxRunner(),
      agent: new ClaudeCodeAgent(fakeClaudeBin),
      artifacts, policy,
      identityFor: () => identity,
      ...(overrides.claudeCodeCredential
        ? { claudeCodeCredential: { secretProvider: { get: async (ref: string) => (ref === "ANTHROPIC_API_KEY" ? "fake-anthropic-key" : null) } } }
        : {})
    }));
    const c = jobContract(overrides.goal !== undefined ? { goal: overrides.goal } : {});
    return { worker, c };
  }

  it("L: ekte CLI-kjøring lykkes (via fake-binær) -> jobben fullfører, description fra CLI-ens JSON-result, FIX.md commitet", async () => {
    const { worker, c } = runCodingJob({ claudeCodeCredential: true });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    const result = view?.result as { description: string; commit_sha: string };
    expect(result.description).toBe("Fixed: fiks null-sjekk");
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    const diffArtifact = (await artifacts.list("tenant-a", c.task_id)).find((a) => a.kind === "patch");
    expect(diffArtifact?.content).toContain("FIX.md");
  });

  it("M: claudeCodeCredential injiserer ANTHROPIC_API_KEY i sandbox-env -> CLI-kjøring som krever nøkkelen lykkes", async () => {
    const { worker, c } = runCodingJob({ claudeCodeCredential: true, goal: "SCENARIO:requires_key" });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
  });

  it("N: UTEN claudeCodeCredential -> ANTHROPIC_API_KEY er ikke i sandbox-env -> ekte, strukturell CLI-autentiseringsfeil (ikke fabrikkert suksess)", async () => {
    const { worker, c } = runCodingJob({ goal: "SCENARIO:requires_key" });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).toContain("claude_code_cli_failed");
    expect(view?.last_error).toContain("ANTHROPIC_API_KEY");
  });

  it("O: CLI-feil (fake-binær exit 1) -> jobben feiler kontrollert, ALDRI push/PR forsøkt (kun seed-commit på main)", async () => {
    const mainBefore = git(bareRepo, "rev-parse", "main");
    const { worker, c } = runCodingJob({ claudeCodeCredential: true, goal: "SCENARIO:fail" });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).toContain("claude_code_cli_failed:simulated_cli_failure");
    expect(git(bareRepo, "rev-parse", "main")).toBe(mainBefore);
    const branches = git(bareRepo, "branch", "--list", `jarvis/${c.task_id}`);
    expect(branches).toBe("");
  });
});
