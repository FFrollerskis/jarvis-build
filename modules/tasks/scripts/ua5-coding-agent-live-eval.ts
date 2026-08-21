#!/usr/bin/env node
/**
 * D-98 UA-5 Real Coding Agent v1 - Live Quality Evaluation.
 *
 * Kjører de tre fixturene i `src/coding-agent-eval.ts` mot den EKTE, kanoniske
 * `ClaudeCodeAgent` (`@jarvis/tasks`) via den EKTE, kanoniske
 * `createCodingHandler`/`ProcessSandboxRunner` - INGEN egen/duplisert
 * sandbox- eller agent-arkitektur. Hver fixture kjøres i et ISOLERT,
 * kastbart lokalt git-repo (aldri det virkelige jarvisbuild-repoet, aldri
 * github.com) - `deps.github` utelates bevisst, så scriptet kan STRUKTURELT
 * ikke opprette en ekte PR eller pushe til en produksjonsbranch.
 *
 * ALDRI en del av `pnpm -w test`/CI - krever ekte `JARVIS_CLAUDE_BIN` +
 * `ANTHROPIC_API_KEY`. Kjør manuelt:
 *
 *   JARVIS_CLAUDE_BIN=/pat/til/claude ANTHROPIC_API_KEY=sk-ant-... \
 *     node --experimental-transform-types modules/tasks/scripts/ua5-coding-agent-live-eval.ts
 *
 * Skriver ETT maskinlesbart JSON-sammendrag til stdout og avslutter 0 - også
 * naar konfigurasjon mangler (`skipped: true`, `HOST_ACTION_REQUIRED: true`,
 * `LIVE_QUALITY_VERIFIED: false`). Lekker ALDRI `ANTHROPIC_API_KEY`/binærsti
 * i noe felt (kun boolske konfig-flagg, jf. §13).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ArtifactStore, ClaudeCodeAgent, InProcessWorker, PgTaskQueue, ProcessSandboxRunner, createCodingHandler } from "@jarvis/tasks";
import {
  EVAL_FIXTURES, QUALITY_THRESHOLD, checkLiveConfiguration, classifyChangedFiles, classifyErrorClass,
  computeVerifiedFix, evaluateTaskAgainstThreshold, redactSecrets,
  type EvalFixture, type EvalTaskResult
} from "../src/coding-agent-eval.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
  return result.stdout.trim();
}

async function seedFixtureRepo(fixture: EvalFixture): Promise<string> {
  const bareRepo = await mkdtemp(join(tmpdir(), `jarvis-eval-origin-${fixture.id}-`));
  git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
  const seed = await mkdtemp(join(tmpdir(), `jarvis-eval-seed-${fixture.id}-`));
  git(seed, "init", "--initial-branch=main", ".");
  git(seed, "config", "user.email", "eval-seed@jarvis.local");
  git(seed, "config", "user.name", "jarvis-eval-seed");
  for (const [relativePath, content] of Object.entries(fixture.seedFiles)) {
    const parts = relativePath.split("/");
    if (parts.length > 1) {
      spawnSync("mkdir", ["-p", parts.slice(0, -1).join("/")], { cwd: seed });
    }
    spawnSync("node", ["-e", `require('fs').writeFileSync(process.argv[1], process.argv[2])`, relativePath, content], { cwd: seed });
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "seed");
  git(seed, "push", bareRepo, "main");
  return bareRepo;
}

function pushedBranchChangedFiles(bareRepo: string, branch: string): string[] | null {
  const check = spawnSync("git", ["rev-parse", "--verify", branch], { cwd: bareRepo, encoding: "utf8" });
  if (check.status !== 0) return null; // aldri pushet - jobben nadde ikke push-steget
  const diff = spawnSync("git", ["diff", "--name-only", "main", branch], { cwd: bareRepo, encoding: "utf8" });
  return diff.stdout.trim().length > 0 ? diff.stdout.trim().split("\n") : [];
}

async function runFixture(
  fixture: EvalFixture, appPool: pg.Pool, policy: PolicyGateway, claudeBin: string, apiKey: string
): Promise<EvalTaskResult> {
  const bareRepo = await seedFixtureRepo(fixture);
  const identity: IdentityContext = {
    person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
    session_id: `sess-eval-${fixture.id}`, device_id: "dev-eval", channel: "web", auth_strength: "active"
  };
  const queue = new PgTaskQueue(appPool);
  const artifacts = new ArtifactStore(appPool);
  const worker = new InProcessWorker(queue, 60);
  worker.register("coding", createCodingHandler({
    sandbox: new ProcessSandboxRunner(),
    agent: new ClaudeCodeAgent(claudeBin),
    artifacts, policy,
    identityFor: () => identity,
    claudeCodeCredential: { secretProvider: { get: async (ref) => (ref === "ANTHROPIC_API_KEY" ? apiKey : null) } }
    // BEVISST ingen `github`-felt - denne evalen kan derfor STRUKTURELT ikke opprette en ekte PR.
  }));
  const contract: JobContract = {
    task_id: `eval-${fixture.id}-${randomUUID()}`, owner_person_id: "person-tobias", tenant_id: "tenant-a",
    goal: fixture.goal, acceptance_criteria: ["independent test command passes"],
    input: { data: { repo_url: bareRepo, test_command: [...fixture.testCommand] }, trust_level: "internal", provenance: "ua5-coding-agent-live-eval" },
    allowed_tools: [], allowed_memory_spaces: ["personal"], allowed_network_targets: [],
    agent_profile: "coding", model_budget_ore: 5000,
    retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3
  };
  await queue.enqueue("tenant-a", contract);
  const startedAt = Date.now();
  await worker.drain();
  const durationMs = Date.now() - startedAt;
  const view = await queue.get("tenant-a", contract.task_id);
  const invocationSuccess = view?.status === "completed";
  const errorClass = classifyErrorClass(view?.last_error ?? null);
  const changedFiles = pushedBranchChangedFiles(bareRepo, `jarvis/${contract.task_id}`);
  const patchCreated = changedFiles !== null;
  const { unauthorizedChanges, oracleTampering } = classifyChangedFiles(
    changedFiles ?? [], fixture.allowedWritablePaths, fixture.oracleFiles
  );
  // `must("tests", ...)`-porten i createCodingHandler kaster FØR push naar testen feiler -
  // en pushet branch betyr derfor strukturelt at den UAVHENGIGE testkommandoen faktisk besto.
  const independentTestsPassed = invocationSuccess && patchCreated;
  const timeout = errorClass === "claude_code_cli_failed" && durationMs > 280_000; // naer/over agentens 300s-default - beste-innsats-heuristikk, se D-98-dok
  const result: EvalTaskResult = {
    task_id: contract.task_id, fixture_id: fixture.id,
    invocation_success: invocationSuccess, patch_created: patchCreated,
    independent_tests_passed: independentTestsPassed,
    unauthorized_changes: unauthorizedChanges, changed_files: changedFiles ?? [],
    oracle_tampering: oracleTampering, timeout,
    verified_fix: computeVerifiedFix({
      invocationSuccess, patchCreated, independentTestsPassed, unauthorizedChanges, oracleTampering, timeout
    }),
    duration_ms: durationMs, error_class: errorClass,
    agent_description: invocationSuccess ? ((view?.result as { description?: string } | undefined)?.description ?? null) : null
  };
  return result;
}

async function main(): Promise<void> {
  const bin = process.env["JARVIS_CLAUDE_BIN"];
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const config = checkLiveConfiguration(bin, apiKey);

  if (!config.configured) {
    console.log(JSON.stringify({
      skipped: true, reason: config.reason,
      CLAUDE_BINARY_CONFIGURED: config.claudeBinaryConfigured,
      ANTHROPIC_CREDENTIAL_CONFIGURED: config.anthropicCredentialConfigured,
      HOST_ACTION_REQUIRED: true,
      LIVE_AGENT_INVOCATION_VERIFIED: false,
      LIVE_DIAGNOSTIC_QUALITY_VERIFIED: false,
      LIVE_FIX_QUALITY_VERIFIED: false,
      QUALITY_THRESHOLD,
      host_command_to_run_later:
        "JARVIS_CLAUDE_BIN=<path-to-claude> ANTHROPIC_API_KEY=<key> node --experimental-transform-types modules/tasks/scripts/ua5-coding-agent-live-eval.ts"
    }, null, 2));
    return;
  }

  const PORT = 30000 + Math.floor(Math.random() * 20000);
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-live-eval-"));
  const epg = new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  const adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  try {
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_live_eval LOGIN PASSWORD 'pw2'");
    await adminPool.query("GRANT jarvis_app TO jarvis_live_eval");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
      INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
    `);
    const appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_live_eval", password: "pw2" });
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(),
      killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"])
    });

    const results: EvalTaskResult[] = [];
    // Sekvensiell, avgrenset - EKSAKT ett ekte provider-kall per fixture, ingen retry-storm (§20).
    for (const fixture of EVAL_FIXTURES) {
      const result = await runFixture(fixture, appPool, policy, bin!, apiKey!);
      results.push(result);
    }

    const perTask = EVAL_FIXTURES.map((fixture, i) => {
      const result = results[i]!;
      return {
        fixture_id: fixture.id, expected_outcome: fixture.expectedOutcome,
        threshold_met: evaluateTaskAgainstThreshold(fixture, result),
        result
      };
    });
    const thresholdMetOverall = perTask.every((t) => t.threshold_met);
    const summary = redactSecrets(JSON.stringify({
      PROVIDER_CALLS_COUNT: EVAL_FIXTURES.length,
      QUALITY_THRESHOLD,
      CLAUDE_BINARY_CONFIGURED: true,
      ANTHROPIC_CREDENTIAL_CONFIGURED: true,
      LIVE_AGENT_INVOCATION_VERIFIED: results.every((r) => r.invocation_success || r.error_class !== null),
      LIVE_DIAGNOSTIC_QUALITY_VERIFIED: thresholdMetOverall,
      LIVE_FIX_QUALITY_VERIFIED: thresholdMetOverall,
      per_task: perTask
    }, null, 2), [apiKey, bin]);
    console.log(summary);
  } finally {
    await adminPool.end().catch(() => undefined);
    await epg.stop().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ fatal_error: String((err as Error).message ?? err) }));
  process.exit(1);
});
