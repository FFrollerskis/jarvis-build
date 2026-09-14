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
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ArtifactStore, ClaudeCodeAgent, InProcessWorker, PgTaskQueue, ProcessSandboxRunner, createCodingHandler } from "@jarvis/tasks";
import { classifyErrorClass } from "../src/coding-agent-eval.ts";

/**
 * D-98 §19: timeout-banen bevises DETERMINISTISK mot en ekte, kjørt fake-
 * binær som ALDRI avslutter (uendelig `setInterval`) + en kort `timeoutMs` -
 * UTEN å bruke noe ekte Anthropic-API-kall (§20 - live-evalen skal ALDRI
 * bruke flere provider-kall enn nødvendig; en timeout-test trenger ingen).
 * Beviser: `spawnSync`s `timeout`-opsjon (i `ProcessSandboxRunner.exec`)
 * dreper barneprosessen, `code` blir ALDRI 0 ved timeout, jobben feiler
 * kontrollert (ALDRI markert "completed"), og ingen branch pushes.
 */

describe("I: timeout-bane (ekte prosesskjøring, INGEN ekte API-kall)", () => {
  let PORT = 0;
  let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let bareRepo: string;
  let neverExitsBin: string;

  const identity: IdentityContext = {
    person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
    session_id: "sess-timeout", device_id: "dev-pc", channel: "web", auth_strength: "active"
  };

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
    return result.stdout.trim();
  }

  beforeAll(async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-cctimeout-"));
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
    await adminPool.query("CREATE ROLE jarvis_test_cctimeout LOGIN PASSWORD 'pw2'");
    await adminPool.query("GRANT jarvis_app TO jarvis_test_cctimeout");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
      INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
    `);
    appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_cctimeout", password: "pw2" });

    bareRepo = await mkdtemp(join(tmpdir(), "jarvis-cctimeout-origin-"));
    git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
    const seed = await mkdtemp(join(tmpdir(), "jarvis-cctimeout-seed-"));
    git(seed, "init", "--initial-branch=main", ".");
    git(seed, "config", "user.email", "seed@test");
    git(seed, "config", "user.name", "seed");
    spawnSync("node", ["-e", "require('fs').writeFileSync('README.md','# repo')"], { cwd: seed });
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "init");
    git(seed, "push", bareRepo, "main");

    // Fake CLI-binær som ALDRI avslutter (etterligner en hengende/runaway ekte prosess).
    const binDir = mkdtempSync(join(tmpdir(), "jarvis-fake-claude-neverexits-"));
    neverExitsBin = join(binDir, "never-exits.js");
    writeFileSync(neverExitsBin, `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`);
    chmodSync(neverExitsBin, 0o755);
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    await stopEmbeddedPostgres?.();
  }, 120_000);

  it("kort timeoutMs -> prosessen drepes, kaster typet claude_code_cli_failed (ALDRI markert bestaatt), ingen branch pushet", async () => {
    const mainBefore = git(bareRepo, "rev-parse", "main");
    const queue = new PgTaskQueue(appPool);
    const artifacts = new ArtifactStore(appPool);
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(),
      killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"])
    });
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox: new ProcessSandboxRunner(),
      agent: new ClaudeCodeAgent(neverExitsBin, 500), // 500ms timeout - bevisst kort, ikke en ekte provider-ventetid
      artifacts, policy,
      identityFor: () => identity
    }));
    const c: JobContract = {
      task_id: `task-${randomUUID()}`, owner_person_id: "person-tobias", tenant_id: "tenant-a",
      goal: "dette skal aldri fullføre", acceptance_criteria: ["fullfører"],
      input: { data: { repo_url: bareRepo }, trust_level: "internal", provenance: "test" },
      allowed_tools: [], allowed_memory_spaces: ["personal"], allowed_network_targets: [],
      agent_profile: "coding", model_budget_ore: 1000,
      retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3
    };
    await queue.enqueue("tenant-a", c);
    const started = Date.now();
    await worker.drain();
    const elapsedMs = Date.now() - started;

    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(classifyErrorClass(view?.last_error ?? null)).toBe("claude_code_cli_failed");
    // Drept trygt innenfor rimelig margin over 500ms-timeouten - ALDRI hengende i minutter (300_000ms default).
    expect(elapsedMs).toBeLessThan(30_000);
    expect(git(bareRepo, "rev-parse", "main")).toBe(mainBefore);
    expect(git(bareRepo, "branch", "--list", `jarvis/${c.task_id}`)).toBe("");
  }, 60_000);
});
