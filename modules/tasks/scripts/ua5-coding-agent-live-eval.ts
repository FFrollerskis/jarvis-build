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
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ArtifactStore, ClaudeCodeAgent, InProcessWorker, PgTaskQueue, ProcessSandboxRunner, createCodingHandler } from "@jarvis/tasks";
import {
  EVAL_FIXTURES, LIVE_EVAL_INITDB_FLAGS, QUALITY_THRESHOLD, checkLiveConfiguration, classifyChangedFiles,
  classifyErrorClass, computeIndependentTestsPassed, computeProviderInvocationSuccess,
  computeHarnessPersistenceSuccess, classifyFailureCategory, computeVerifiedFix, evaluateTaskAgainstThreshold,
  redactSecrets, type EvalFixture, type EvalTaskResult
} from "../src/coding-agent-eval.ts";
import { seedFixtureRepo } from "../src/eval-fixture-repo.ts";

function pushedBranchChangedFiles(bareRepo: string, branch: string): string[] | null {
  const check = spawnSync("git", ["rev-parse", "--verify", branch], { cwd: bareRepo, encoding: "utf8" });
  if (check.status !== 0) return null; // aldri pushet - jobben nadde ikke push-steget
  const diff = spawnSync("git", ["diff", "--name-only", "main", branch], { cwd: bareRepo, encoding: "utf8" });
  return diff.stdout.trim().length > 0 ? diff.stdout.trim().split("\n") : [];
}

/**
 * D-100 §9/§22: leser `hiddenOracle.checkPath` DIREKTE fra det pushede
 * innholdet i det barte repoet - ALDRI fra sandboxen agenten selv kjørte i
 * (som allerede er disponert på dette tidspunktet). KUN til diagnostikk
 * (`hidden_oracle_match`) - påvirker ALDRI `verified_fix`.
 */
function checkHiddenOracle(fixture: EvalFixture, bareRepo: string, branch: string, patchCreated: boolean): boolean | null {
  if (!fixture.hiddenOracle) return null;
  if (!patchCreated) return null;
  const show = spawnSync("git", ["show", `${branch}:${fixture.hiddenOracle.checkPath}`], { cwd: bareRepo, encoding: "utf8" });
  if (show.status !== 0) return null;
  return fixture.hiddenOracle.isCorrect(show.stdout);
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
  const branch = `jarvis/${contract.task_id}`;
  const changedFiles = pushedBranchChangedFiles(bareRepo, branch);
  const patchCreated = changedFiles !== null;
  const { unauthorizedChanges, oracleTampering } = classifyChangedFiles(
    changedFiles ?? [], fixture.allowedWritablePaths, fixture.oracleFiles
  );
  // D-100 §5/§14: `provider_invocation_success` er den KORRIGERTE, presise
  // "lyktes det ekte Claude Code-kallet"-signalet - ALDRI forvekslet med en
  // SEN, urelatert `invocation_success`(jobb-status)-feil (Task A/B-hendelsen:
  // en pr-proposal-artefakt-lagring feilet ETTER en allerede-pushet branch).
  const providerInvocationSuccess = computeProviderInvocationSuccess(patchCreated, errorClass);
  const harnessPersistenceSuccess = computeHarnessPersistenceSuccess(errorClass);
  const failureCategory = classifyFailureCategory(errorClass);
  // D-100 §7/§8/§21: for Task C v2 (hiddenOracle) kan den agent-synlige
  // testkommandoen ALDRI strukturelt bevise korrekthet - denne funksjonen
  // returnerer ALLTID false for slike fixtures, uansett `patchCreated`.
  const independentTestsPassed = computeIndependentTestsPassed(fixture, patchCreated);
  const timeout = errorClass === "claude_code_cli_failed" && durationMs > 280_000; // naer/over agentens 300s-default - beste-innsats-heuristikk, se D-98-dok
  const hiddenOracleMatch = checkHiddenOracle(fixture, bareRepo, branch, patchCreated);
  const result: EvalTaskResult = {
    task_id: contract.task_id, fixture_id: fixture.id,
    invocation_success: invocationSuccess, provider_invocation_success: providerInvocationSuccess,
    patch_created: patchCreated,
    independent_tests_passed: independentTestsPassed,
    unauthorized_changes: unauthorizedChanges, changed_files: changedFiles ?? [],
    oracle_tampering: oracleTampering, timeout,
    harness_persistence_success: harnessPersistenceSuccess, failure_category: failureCategory,
    hidden_oracle_match: hiddenOracleMatch,
    verified_fix: computeVerifiedFix({
      providerInvocationSuccess, patchCreated, independentTestsPassed, unauthorizedChanges, oracleTampering, timeout
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

  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-live-eval-"));
  // D-100 §4: eksplisitt UTF8-encoding+C-locale - uten dette avleder `initdb`
  // encoding fra vertens OS-locale (WIN1252 pa den affiserte Windows-verten,
  // UTF8 pa Linux/glibc) - `C`-locale er reservert og garantert tilgjengelig
  // pa enhver plattform uten et installert sprakspraak.
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({
      databaseDir, user: "postgres", password: "pw", port, persistent: false,
      initdbFlags: [...LIVE_EVAL_INITDB_FLAGS]
    })
  );
  const epg = leasedPostgres.postgres;
  const PORT = leasedPostgres.port;
  await epg.createDatabase("jarvis_test");
  const adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  // D-100 §16: deklarert i ytre scope slik at `finally` kan lukke DENNE poolen
  // FOR `adminPool`/`epg.stop()` - den observerte
  // `pg_pool_idle_client_error`-stoyen etter siste JSON-utskrift skyldtes at
  // denne poolen aldri ble eksplisitt lukket, sa Postgres ble stoppet mens den
  // fortsatt hadde en aktiv/idle-tilkobling.
  let appPool: pg.Pool | null = null;
  try {
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_live_eval LOGIN PASSWORD 'pw2'");
    await adminPool.query("GRANT jarvis_app TO jarvis_live_eval");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
      INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
    `);
    appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_live_eval", password: "pw2" });
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(),
      killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"])
    });

    const results: EvalTaskResult[] = [];
    // Sekvensiell, avgrenset - EKSAKT ett ekte provider-kall per fixture, ingen retry-storm (§20).
    for (const fixture of EVAL_FIXTURES) {
      const result = await runFixture(fixture, appPool!, policy, bin!, apiKey!);
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
      LIVE_AGENT_INVOCATION_VERIFIED: results.every((r) => r.provider_invocation_success),
      LIVE_DIAGNOSTIC_QUALITY_VERIFIED: thresholdMetOverall,
      LIVE_FIX_QUALITY_VERIFIED: thresholdMetOverall,
      per_task: perTask
    }, null, 2), [apiKey, bin]);
    console.log(summary);
  } finally {
    // D-100 §16: lukk appPool FOR adminPool/epg.stop() - riktig
    // disponeringsrekkefolge eliminerer den observerte
    // `pg_pool_idle_client_error`-teardown-stoyen (TEARDOWN_ONLY=true; ikke
    // modell-kvalitetsbevis, se D-100-dok).
    if (appPool) await appPool.end().catch(() => undefined);
    await adminPool.end().catch(() => undefined);
    await leasedPostgres.stop().catch(() => undefined);
  }
}

main().catch((err) => {
  const message = redactSecrets(String((err as Error).message ?? err), [
    process.env["ANTHROPIC_API_KEY"], process.env["JARVIS_CLAUDE_BIN"]
  ]);
  console.error(JSON.stringify({ fatal_error: message }));
  process.exit(1);
});
