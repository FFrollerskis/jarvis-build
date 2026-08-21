import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import { publishPullRequestForCodingJob, type PrPublishingGateway } from "./pr-publisher.ts";
import type { SandboxRunner } from "./sandbox.ts";
import type { TaskHandler } from "./worker.ts";

/** Kodejobb-eksekutør slik sandboxen faktisk eksponerer den (samme signatur som `Sandbox.exec`). */
export type CodingAgentExec = (cmd: string, args: string[], timeoutMs?: number) => { code: number; stdout: string; stderr: string };

/** Kodeagent bak adapter: skriptet i test; Claude Code headless når binær/nøkkel finnes. */
export interface CodingAgentAdapter {
  readonly name: string;
  /** Gjør endringen i workdir; returnerer beskrivelse av hva som ble gjort. */
  modify(workdirExec: CodingAgentExec, goal: string): Promise<string>;
}

export class ScriptedCodingAgent implements CodingAgentAdapter {
  readonly name = "scripted-agent";
  async modify(exec: CodingAgentExec, goal: string): Promise<string> {
    const content = `# Endring utført av jarvis-worker\n\nMål: ${goal}\n`;
    const escaped = content.replace(/\n/g, "\\n").replace(/"/g, '\\"');
    exec("node", ["-e", `require('fs').writeFileSync('CHANGES.md', "${escaped}")`]);
    return "La til CHANGES.md med målbeskrivelse";
  }
}

/**
 * D-96 Real Coding Agent v1: ekte, ikke-interaktiv Claude Code CLI-kjøring
 * (JARVIS_CLAUDE_BIN), INNE i den eksisterende jobb-sandboxen (samme `exec`
 * som resten av kodejobben - ingen egen/ny sandbox). Verifisert MOT
 * offisiell dokumentasjon (https://code.claude.com/docs/en/headless,
 * 2026-08-20), ikke antatt:
 *
 * - `-p "<mål>"` = ikke-interaktiv engangs-kjøring (dokumentert oppførsel).
 * - `--bare` = hopper over hook/plugin/CLAUDE.md-oppdagelse - PÅKREVD her:
 *   uten `--bare` forventer `-p` interaktiv OAuth/nøkkelring-innlogging, som
 *   en engangs, tom sandbox strukturelt ALDRI har tilgang til (ingen
 *   vedvarende `~/.claude`-tilstand følger med en kastbar jobb-sandbox).
 *   Med `--bare` autentiseres CLI-en KUN via `ANTHROPIC_API_KEY` i prosess-
 *   env - injisert EKSPLISITT (se `createCodingHandler`s `claudeCodeCredential`),
 *   ALDRI arvet fra Jarvis-prosessen (samme "ren env"-prinsipp som resten av
 *   sandboxen).
 * - `--permission-mode acceptEdits` = filredigering skjer uten et (umulig,
 *   ubetjent) godkjenningsprompt.
 * - `--allowedTools "Read,Edit"` - BEVISST IKKE "Bash": agenten skal KUN
 *   foreslå en diff. Den EKSISTERENDE test-porten i `createCodingHandler`
 *   kjører den ekte testkommandoen PÅ NYTT etterpå, uendret - agenten kan
 *   ALDRI selv erklære "testene består" (jf. Q-26).
 * - `--output-format json` = strukturert `{result: "<tekst>"}`-utgang.
 * - Suksess/feil avgjøres UTELUKKENDE av prosessens exit-kode (dokumentert
 *   kontrakt: 0 = suksess, ikke-null = feil) - ALDRI av å tolke fritekst.
 *
 * Persisterer KUN en kort, strukturert beskrivelse (CLI-ens `result`-felt) -
 * ALDRI en skjult resonnerings-logg (Q-26/§13: ingen chain-of-thought lagres).
 */
export class ClaudeCodeAgent implements CodingAgentAdapter {
  readonly name = "claude-code";
  constructor(
    private readonly bin: string | undefined = process.env["JARVIS_CLAUDE_BIN"],
    private readonly timeoutMs = 300_000
  ) {}

  async modify(exec: CodingAgentExec, goal: string): Promise<string> {
    if (!this.bin) {
      throw new Error("claude_code_not_configured");
    }
    const args = [
      "-p", goal,
      "--bare",
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit"
    ];
    const result = exec(this.bin, args, this.timeoutMs);
    if (result.code !== 0) {
      throw new Error(`claude_code_cli_failed:${(result.stderr || result.stdout || "").slice(0, 300)}`);
    }
    const description = parseClaudeCodeCliResult(result.stdout);
    if (!description) {
      throw new Error(`claude_code_cli_invalid_output:${result.stdout.slice(0, 300)}`);
    }
    return description;
  }
}

/** `--output-format json` sitt `result`-felt; faller tilbake til rå stdout kun hvis JSON-parsing feiler (ALDRI hvis den lykkes men `result` mangler/er tom - det er en reell, rapporterbar feil). */
function parseClaudeCodeCliResult(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    return typeof parsed.result === "string" && parsed.result.length > 0 ? parsed.result : null;
  } catch {
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
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
 * D-101: kastet i stedet for å tvinge frem `git add`/`git commit` når agenten
 * ikke gjorde noen endring i det hele tatt. FØR denne reparasjonen forsøkte
 * `createCodingHandler` UBETINGET `git add -A` + `git commit` selv naar
 * arbeidstreet var helt uendret - `git commit` feiler da med "nothing to
 * commit" (skrevet til STDOUT, ikke stderr - samme feilklasse som D-99s
 * opprinnelige `seedFixtureRepo`-bug, men her i selve PRODUKSJONShandleren),
 * som `must("commit", ...)` fanget som en tom, ugjennomsiktig
 * `commit_failed: `-feil - et EKTE, uavhengig live-evalueringsfunn (D-101,
 * Task C: agenten korrekt og ærlig avsto fra å gjette en verdi den ikke
 * hadde grunnlag for, jf. Task C sin `honest_failure`-fixture i
 * `coding-agent-eval.ts`) klassifiserte dette feilaktig som en harness-
 * PERSISTENS-feil i stedet for hva det faktisk var: et strukturelt KORREKT
 * "agenten fant ingen fiks å gjøre"-utfall. Denne eksporterte, stabile
 * etiketten (ALDRI pakket i `must()`s "<label>_failed:"-konvensjon) lar
 * evalueringslaget (`coding-agent-eval.ts`) skille dette presist fra en ekte
 * git-/harness-mekanikk-feil - se `classifyFailureCategory()`.
 *
 * VIKTIG (§9 i D-101-ordren): jobben MARKERES FORTSATT SOM FEILET (aldri
 * "completed") naar dette skjer - en produksjonskodejobb som forventet en
 * ekte fiks skal ALDRI stille fremstå som vellykket bare fordi ingen endring
 * ble gjort. Denne reparasjonen endrer KUN hvilken (ærlig, presis) feil som
 * kastes - ALDRI om jobben lykkes.
 */
export const NO_CHANGES_TO_COMMIT_LABEL = "no_changes_to_commit";

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
  /**
   * D-96 Real Coding Agent v1 (valgfritt): credential som injiseres i
   * sandboxens prosess-env (aldri arvet fra Jarvis-prosessen) - KUN når
   * `agent` faktisk trenger en (f.eks. `ClaudeCodeAgent` sin
   * `ANTHROPIC_API_KEY` for `--bare`-autentisering). Duck-typed mot
   * `SecretProvider` (samme mønster som `PrPublishingGateway` - ingen
   * pakkeavhengighet til `@jarvis/tool-gateway`). Uten dette feltet er
   * sandbox-oppførselen 100% uendret (tom jobEnv, som før D-96).
   */
  claudeCodeCredential?: { secretProvider: { get(ref: string): Promise<string | null> }; ref?: string };
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

    const jobEnv: Record<string, string> = {};
    if (deps.claudeCodeCredential) {
      const ref = deps.claudeCodeCredential.ref ?? "ANTHROPIC_API_KEY";
      const value = await deps.claudeCodeCredential.secretProvider.get(ref);
      if (value) jobEnv[ref] = value;
    }
    const sandbox = await deps.sandbox.create(jobEnv);
    try {
      const run: CodingAgentExec = (cmd, args, timeoutMs) => sandbox.exec(cmd, args, timeoutMs);
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

      // D-101: sjekk FØR noen `git add`/`commit` forsøkes - en agent som
      // korrekt og ærlig ikke gjorde noen endring (f.eks. fordi den ikke
      // hadde grunnlag for å gjette en verdi) skal ALDRI tvinges gjennom en
      // tom commit eller få dette fremstilt som en git-/harness-mekanikk-feil.
      const status = sandbox.exec("git", ["status", "--porcelain"]);
      if (status.stdout.trim().length === 0) {
        throw new Error(NO_CHANGES_TO_COMMIT_LABEL);
      }
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

/**
 * D-102: defense-in-depth for production coding jobs (§7/§23 i byggeordren) -
 * ALDRI en ny hemmelighet-lagringsmekanisme, KUN en siste sikkerhetsnett rundt
 * ETHVERT thrown-error-budskap som når `queue.fail()` (og dermed
 * `tasks.last_error`, lesbar via `TaskService.get()`). `createCodingHandler`
 * injiserer selv ALDRI en hemmelighet i en feilmelding den bygger - men den
 * ekte Claude Code-CLI-en (subprosess, utenfor Jarvis sin kontroll) kunne i
 * prinsippet ekko sin egen `ANTHROPIC_API_KEY`-miljøvariabel tilbake i
 * stdout/stderr, som `ClaudeCodeAgent.modify()` da ville inkludert (trunkert
 * til 300 tegn) i en kastet `claude_code_cli_failed:`-feil. Wrapperen fjerner
 * ethvert kjent hemmelig-formet argument fra `err.message` FØR det noensinne
 * når køen - identisk teknikk som den allerede eksisterende, testede
 * `redactSecrets()` i `coding-agent-eval.ts` (D-98), ALDRI en ny mekanisme.
 */
export function withSecretRedaction(handler: TaskHandler, secrets: readonly (string | undefined)[]): TaskHandler {
  return async (task, ctx) => {
    try {
      return await handler(task, ctx);
    } catch (err) {
      let message = (err as Error).message;
      for (const secret of secrets) {
        if (secret && secret.length > 0) message = message.split(secret).join("[REDACTED]");
      }
      throw new Error(message);
    }
  };
}
