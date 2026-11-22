import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { JobContract } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  ProcessSandboxRunner, createCodingHandler,
  type ArtifactStore, type ClaimedTask, type CodingAgentAdapter, type CodingAgentExec, type JobContext
} from "@jarvis/tasks";

/**
 * WP-K (D-471, JARVIS-068): `tests: "passed"` i en kodejobb sin resultat forteller nå HVA den hviler på. Uten en oppgitt testkommando kjører Jarvis' interne standard (en kommando som alltid består);
 * da er «passed» ikke bevis for at noe ble testet. `tests_basis` skiller `contract_command` (kontraktstyrt, validert testløper) fra `internal_default_noop`. Feltet endrer ingen oppførsel.
 * Ekte `git` mot et lokalt bare-repo og ekte `ProcessSandboxRunner`; ingen nettverk, ingen Postgres.
 */
const identity = { person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal", session_id: "sess-wpk068", device_id: "dev-pc", channel: "web", auth_strength: "active" } as const;
let bareRepo = "";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(async () => {
  bareRepo = await mkdtemp(join(tmpdir(), "jarvis-wpk068-origin-"));
  git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
  const seed = await mkdtemp(join(tmpdir(), "jarvis-wpk068-seed-"));
  git(seed, "init", "--initial-branch=main", ".");
  git(seed, "config", "user.email", "seed@test");
  git(seed, "config", "user.name", "seed");
  await writeFile(join(seed, "README.md"), "# repo\n");
  await writeFile(join(seed, "check.js"), "process.exit(0);\n"); // en kontraktstyrt testfil (`node check.js` er en tillatt testløper)
  await writeFile(join(seed, "failing-check.js"), "process.exit(3);\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "init");
  git(seed, "push", bareRepo, "main");
}, 120_000);

class WritingAgent implements CodingAgentAdapter {
  readonly name = "writing-agent";
  async modify(exec: CodingAgentExec): Promise<string> {
    await exec("node", ["-e", "require('fs').writeFileSync('CHANGES.md','endret')"]);
    return "endret CHANGES.md";
  }
}

function claimed(testCommand?: string[]): ClaimedTask {
  const task_id = `task-wpk068-${randomBytes(4).toString("hex")}`;
  const contract = {
    task_id, owner_person_id: "person-tobias", tenant_id: "tenant-a", goal: "wpk068", acceptance_criteria: ["fullfører"],
    input: { data: { repo_url: bareRepo, ...(testCommand ? { test_command: testCommand } : {}) }, trust_level: "internal", provenance: "test" },
    allowed_tools: [], allowed_memory_spaces: ["personal"], allowed_network_targets: [], agent_profile: "coding", model_budget_ore: 1000,
    retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3
  } as unknown as JobContract;
  return { task_id, tenant_id: "tenant-a", contract, attempts: 1, checkpoint: null };
}

const jobContext: JobContext = { attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled: async () => undefined };

function handler() {
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"]) });
  const artifacts = { save: async () => undefined, list: async () => [] } as unknown as ArtifactStore;
  return createCodingHandler({ sandbox: new ProcessSandboxRunner(), agent: new WritingAgent(), artifacts, policy, identityFor: () => identity });
}

describe("tests_basis: hva «tests: passed» hviler på", () => {
  it("uten testkommando kjører den interne standarden: passed, men basis = internal_default_noop (ikke bevis for at noe ble testet)", async () => {
    const result = await handler()(claimed(), jobContext);
    expect(result["tests"]).toBe("passed");
    expect(result["tests_basis"]).toBe("internal_default_noop");
  }, 60_000);

  it("med en kontraktstyrt, validert testkommando: passed med basis = contract_command", async () => {
    const result = await handler()(claimed(["node", "check.js"]), jobContext);
    expect(result["tests"]).toBe("passed");
    expect(result["tests_basis"]).toBe("contract_command");
  }, 60_000);

  it("en tom testkommando (tom liste) er IKKE en kontraktstyrt test: basis = internal_default_noop", async () => {
    const result = await handler()(claimed([]), jobContext);
    expect(result["tests_basis"]).toBe("internal_default_noop");
  }, 60_000);

  it("en testkommando som feiler gir fortsatt en feilet jobb (uendret): ingen `passed`, ingen basis å lese", async () => {
    await expect(handler()(claimed(["node", "failing-check.js"]), jobContext)).rejects.toThrow(/tests_failed/);
  }, 60_000);

  it("en ulovlig testkommando avvises som før (assertTestCommand er uendret): coding_input_rejected", async () => {
    await expect(handler()(claimed(["node", "-e", "process.exit(0)"]), jobContext)).rejects.toThrow("coding_input_rejected:test_command_not_allowed");
  }, 60_000);
});
