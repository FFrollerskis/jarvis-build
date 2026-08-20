import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import { publishPullRequestForCodingJob, type PrPublishingGateway } from "./pr-publisher.ts";
import type { SandboxRunner } from "./sandbox.ts";
import type { TaskHandler } from "./worker.ts";

/** Kodeagent bak adapter: skriptet i test; Claude Code headless når binær/nøkkel finnes. */
export interface CodingAgentAdapter {
  readonly name: string;
  /** Gjør endringen i workdir; returnerer beskrivelse av hva som ble gjort. */
  modify(workdirExec: (cmd: string, args: string[]) => { code: number }, goal: string): Promise<string>;
}

export class ScriptedCodingAgent implements CodingAgentAdapter {
  readonly name = "scripted-agent";
  async modify(exec: (cmd: string, args: string[]) => { code: number }, goal: string): Promise<string> {
    const content = `# Endring utført av jarvis-worker\n\nMål: ${goal}\n`;
    const escaped = content.replace(/\n/g, "\\n").replace(/"/g, '\\"');
    exec("node", ["-e", `require('fs').writeFileSync('CHANGES.md', "${escaped}")`]);
    return "La til CHANGES.md med målbeskrivelse";
  }
}

/** Claude Code headless (JARVIS_CLAUDE_BIN). UVERIFISERT til binær+nøkkel er konfigurert. */
export class ClaudeCodeAgent implements CodingAgentAdapter {
  readonly name = "claude-code";
  constructor(private readonly bin: string | undefined = process.env["JARVIS_CLAUDE_BIN"]) {}
  async modify(): Promise<string> {
    if (!this.bin) {
      throw new Error("claude_code_not_configured");
    }
    throw new Error("claude_code_unverified_in_phase6: aktiveres med reell noekkel/miljoe");
  }
}

export class ArtifactStore {
  constructor(private readonly pool: pg.Pool) {}
  async save(tenantId: string, taskId: string, kind: string, name: string, content: string): Promise<void> {
    await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `INSERT INTO artifacts (artifact_id, task_id, tenant_id, kind, name, content)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`art-${randomUUID()}`, taskId, tenantId, kind, name, content.slice(0, 100_000)]
      )
    );
  }
  async list(tenantId: string, taskId: string): Promise<Array<{ kind: string; name: string; content: string }>> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query("SELECT kind, name, content FROM artifacts WHERE task_id = $1 ORDER BY created_at", [taskId])
    );
    return result.rows as Array<{ kind: string; name: string; content: string }>;
  }
}

const PROTECTED_BRANCHES = new Set(["main", "master", "production"]);

/**
 * Kodejobb-handler: sandbox → clone → branch → agentendring → tester →
 * commit → push av JOBB-BRANCH (aldri beskyttet branch) → artefakter
 * (patch, testlogg, PR-forslag). PR-opprettelse mot GitHub krever API-tilgang
 * og er et artefakt/forslag her; merge er ALLTID menneskelig gate.
 * Push krever klasse C-mandat i Policy Gateway ("git:push_branch").
 */
export function createCodingHandler(deps: {
  sandbox: SandboxRunner;
  agent: CodingAgentAdapter;
  artifacts: ArtifactStore;
  policy: PolicyGateway;
  identityFor: (task: { tenant_id: string; contract: { owner_person_id: string } }) => IdentityContext;
  /**
   * UA-5 Tested Fix Orchestrator v1 (D-95, valgfritt): når satt, forsøker
   * en vellykket kodejobb å åpne en EKTE GitHub-PR for jobb-branchen (via
   * eksisterende `github.create_pr`, klasse C) - KUN når jobbkontrakten selv
   * lister "github" i allowed_tools. Uten dette feltet er oppførselen
   * UENDRET (kun det lokale pr-proposal-artefaktet, som før D-95).
   */
  github?: { gateway: PrPublishingGateway; base?: string };
}): TaskHandler {
  return async (task, ctx) => {
    const input = task.contract.input.data as { repo_url?: string; test_command?: string[] };
    if (!input.repo_url) {
      throw new Error("coding_job_missing_repo_url");
    }
    const branch = `jarvis/${task.task_id}`;
    if (PROTECTED_BRANCHES.has(branch)) {
      throw new Error("protected_branch_refused");
    }

    // Policy-mandat for utgående push (klasse C) - delegert agent omgår aldri policy.
    const decision = await deps.policy.authorize({
      identity: deps.identityFor(task),
      toolCall: {
        tool_id: "git",
        action: "push_branch",
        capability_class: "C",
        parameters: { repo: input.repo_url, branch }
      }
    });
    if (decision.decision !== "ALLOW") {
      throw new Error(`policy_denied:${decision.reason}`);
    }

    const sandbox = await deps.sandbox.create();
    try {
      const run = (cmd: string, args: string[]) => sandbox.exec(cmd, args);
      const must = (label: string, result: { code: number; stderr?: string }) => {
        if (result.code !== 0) {
          throw new Error(`${label}_failed: ${result.stderr ?? ""}`.slice(0, 300));
        }
      };
      must("clone", sandbox.exec("git", ["clone", input.repo_url, "."]));
      await ctx.assertNotCancelled();
      must("branch", run("git", ["checkout", "-b", branch]));
      const description = await deps.agent.modify(run, task.contract.goal);
      await ctx.saveCheckpoint({ step: "modified", branch });
      await ctx.assertNotCancelled();

      const testCmd = input.test_command ?? ["node", "-e", "process.exit(0)"];
      const testResult = sandbox.exec(testCmd[0] as string, testCmd.slice(1));
      await deps.artifacts.save(task.tenant_id, task.task_id, "test-log", "tests.txt",
        `exit=${testResult.code}\n${testResult.stdout}\n${testResult.stderr}`);
      must("tests", testResult);

      must("add", run("git", ["add", "-A"]));
      must("commit", run("git", ["commit", "-m", `jarvis: ${task.contract.goal}`]));
      const commitSha = run("git", ["rev-parse", "HEAD"]).stdout.trim();
      const diff = sandbox.exec("git", ["show", "--stat", "HEAD"]);
      await deps.artifacts.save(task.tenant_id, task.task_id, "patch", "change.txt", diff.stdout);
      // Guard i runneren: kun jobb-branchen pushes; aldri beskyttede brancher.
      must("push", run("git", ["push", "origin", `${branch}:${branch}`]));
      await deps.artifacts.save(task.tenant_id, task.task_id, "pr-proposal", "pr.json",
        JSON.stringify({ branch, title: `jarvis: ${task.contract.goal}`, body: description, merge: "KREVER MENNESKELIG GODKJENNING" }));

      let pr: Awaited<ReturnType<typeof publishPullRequestForCodingJob>> | undefined;
      if (deps.github) {
        pr = await publishPullRequestForCodingJob({
          gateway: deps.github.gateway,
          identity: deps.identityFor(task),
          jobContract: task.contract,
          repoUrl: input.repo_url,
          branch,
          base: deps.github.base ?? "main",
          title: `jarvis: ${task.contract.goal}`,
          body: description
        });
        await deps.artifacts.save(task.tenant_id, task.task_id, "pr-result", "pr-result.json", JSON.stringify(pr));
      }

      return { branch, description, tests: "passed", commit_sha: commitSha, ...(pr ? { pr } : {}) };
    } finally {
      await sandbox.dispose();
    }
  };
}
